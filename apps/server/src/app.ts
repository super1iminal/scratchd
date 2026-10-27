import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  ALPHABET,
  CHANNEL_LENGTH,
  CHUNK_SIZE,
  CODE_TTL_MS,
  MAX_FILE_BYTES,
  MAX_JOIN_FAILURES,
  PAD_TTL_MS,
  randomCode,
  type ChannelStatus,
  type CreatePadInput,
  type PadInfo,
} from '@scratchd/shared';
import { BUCKET, TABLE, db, s3, signedUrl } from './aws.ts';

// One DynamoDB table, keyed by `pad#<id>` or `chan#<id>`. `ttl` (epoch seconds) lets DynamoDB
// delete old rows eventually; reads still check expiresAt because TTL can lag by a day or two.
interface PadItem extends PadInfo {
  pk: string;
  tokens: Set<string>; // SHA-256 of each device's token
  uploadId: string;
  etags: string[];
  ttl: number;
}
interface ChannelItem {
  pk: string;
  padId: string;
  salt: string;
  verifier?: string; // removed once the code is used or burned
  wrapped?: string;
  failures: number;
  status: ChannelStatus;
  expiresAt: number;
  ttl: number;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const objectKey = (padId: string) => `pads/${padId}`;
const epochSeconds = (ms: number) => Math.ceil(ms / 1000);
const hex = (length: number) => ({ type: 'string', pattern: `^[0-9a-f]{${length}}$` });
const body = (properties: Record<string, object>) => ({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties });
const padParams = { type: 'object', properties: { padId: hex(32), index: { type: 'integer', minimum: 0 } } };
const channelParams = { type: 'object', properties: { channelId: { type: 'string', pattern: `^[${ALPHABET}]{${CHANNEL_LENGTH}}$` } } };

// A lost race on a conditional write means someone else changed the row first.
const conditional = <T>(p: Promise<T>, status: number, message: string) =>
  p.catch((e) => {
    throw e instanceof ConditionalCheckFailedException ? new HttpError(status, message) : e;
  });

async function authedPad(req: FastifyRequest): Promise<PadItem> {
  const { padId } = req.params as { padId: string };
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const pad = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `pad#${padId}` } }))).Item as PadItem | undefined;
  if (!pad || pad.expiresAt < Date.now() || !pad.tokens.has(hash(token))) throw new HttpError(404, 'Pad not found');
  return pad;
}

async function openChannel(req: FastifyRequest): Promise<ChannelItem> {
  const { channelId } = req.params as { channelId: string };
  const c = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `chan#${channelId}` } }))).Item as ChannelItem | undefined;
  if (!c || c.expiresAt < Date.now()) throw new HttpError(404, 'Code not found or expired');
  return c;
}

const padInfo = ({ padId, meta, size, chunks, uploaded, expiresAt }: PadItem): PadInfo => ({ padId, meta, size, chunks, uploaded, expiresAt });

export function buildApp() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.validation) return reply.code(400).send({ error: 'Invalid request' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/pads', { schema: { body: body({ meta: { type: 'string', pattern: '^[0-9a-f]+$', maxLength: 4096 }, size: { type: 'integer', minimum: 0, maximum: MAX_FILE_BYTES }, chunks: { type: 'integer', minimum: 1 } }) } }, async (req) => {
    const { meta, size, chunks } = req.body as CreatePadInput;
    if (chunks !== Math.max(1, Math.ceil(size / CHUNK_SIZE))) throw new HttpError(400, 'Invalid request');
    const padId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: objectKey(padId) }));
    const expiresAt = Date.now() + PAD_TTL_MS;
    const item: PadItem = { pk: `pad#${padId}`, padId, meta, size, chunks, uploaded: 0, expiresAt, ttl: epochSeconds(expiresAt), tokens: new Set([hash(token)]), uploadId: UploadId!, etags: [] };
    await db.send(new PutCommand({ TableName: TABLE, Item: item }));
    return { padId, token, expiresAt };
  });

  app.get('/api/pads/:padId', { schema: { params: padParams } }, async (req) => padInfo(await authedPad(req)));

  // Parts go straight from the browser to storage, strictly in order (part n+1 = chunk n).
  app.get('/api/pads/:padId/parts/:index/url', { schema: { params: padParams } }, async (req) => {
    const pad = await authedPad(req);
    const { index } = req.params as { index: number };
    if (index !== pad.uploaded || index >= pad.chunks) throw new HttpError(409, 'Upload parts in order');
    return { url: await signedUrl(objectKey(pad.padId), { uploadId: pad.uploadId, partNumber: index + 1 }) };
  });

  app.post('/api/pads/:padId/parts/:index', { schema: { params: padParams, body: body({ etag: { type: 'string', maxLength: 200 } }) } }, async (req, reply) => {
    const pad = await authedPad(req);
    const { index } = req.params as { index: number };
    const { etag } = req.body as { etag: string };
    if (index !== pad.uploaded || index >= pad.chunks) throw new HttpError(409, 'Upload parts in order');
    if (index === pad.chunks - 1) {
      const Parts = [...pad.etags, etag].map((ETag, i) => ({ ETag, PartNumber: i + 1 }));
      await s3.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: objectKey(pad.padId), UploadId: pad.uploadId, MultipartUpload: { Parts } }));
    }
    await conditional(
      db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: pad.pk },
          UpdateExpression: 'SET uploaded = :next, etags = list_append(etags, :etag)',
          ConditionExpression: 'uploaded = :index',
          ExpressionAttributeValues: { ':next': index + 1, ':etag': [etag], ':index': index },
        }),
      ),
      409,
      'Upload parts in order',
    );
    return reply.code(204).send();
  });

  // Chunks are read with Range requests against this one URL.
  app.get('/api/pads/:padId/url', { schema: { params: padParams } }, async (req) => {
    const pad = await authedPad(req);
    if (pad.uploaded < pad.chunks) throw new HttpError(409, 'Still uploading');
    return { url: await signedUrl(objectKey(pad.padId)) };
  });

  app.delete('/api/pads/:padId', { schema: { params: padParams } }, async (req, reply) => {
    const pad = await authedPad(req);
    await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: pad.pk } }));
    const Key = objectKey(pad.padId);
    if (pad.uploaded === pad.chunks) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));
    else await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key, UploadId: pad.uploadId }));
    return reply.code(204).send();
  });

  app.post('/api/pads/:padId/channels', { schema: { params: padParams, body: body({ salt: hex(32), verifier: hex(64), wrapped: hex(120) }) } }, async (req) => {
    const pad = await authedPad(req);
    const { salt, verifier, wrapped } = req.body as { salt: string; verifier: string; wrapped: string };
    const now = Date.now();
    const expiresAt = now + CODE_TTL_MS;
    // Channel ids are short, so retry on collision; expired rows (TTL hasn't caught up) are fair game.
    for (let attempt = 0; attempt < 10; attempt++) {
      const channelId = randomCode(CHANNEL_LENGTH);
      const item: ChannelItem = { pk: `chan#${channelId}`, padId: pad.padId, salt, verifier, wrapped, failures: 0, status: 'open', expiresAt, ttl: epochSeconds(expiresAt) };
      try {
        await db.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now', ExpressionAttributeValues: { ':now': now } }));
        return { channelId, expiresAt };
      } catch (e) {
        if (!(e instanceof ConditionalCheckFailedException)) throw e;
      }
    }
    throw new HttpError(503, 'No free codes right now. Try again.');
  });

  app.get('/api/channels/:channelId', { schema: { params: channelParams } }, async (req) => {
    const c = await openChannel(req);
    return { salt: c.salt, status: c.status };
  });

  app.post('/api/channels/:channelId/claim', { schema: { params: channelParams, body: body({ verifier: hex(64) }) } }, async (req) => {
    const c = await openChannel(req);
    const { verifier } = req.body as { verifier: string };
    if (c.status !== 'open') throw new HttpError(404, 'Code not found or expired');
    const Key = { pk: c.pk };
    const names = { '#s': 'status', '#w': 'wrapped' };

    if (!timingSafeEqual(Buffer.from(c.verifier!, 'hex'), Buffer.from(verifier, 'hex'))) {
      const { Attributes } = await conditional(
        db.send(new UpdateCommand({ TableName: TABLE, Key, UpdateExpression: 'ADD failures :one', ConditionExpression: '#s = :open', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':one': 1, ':open': 'open' }, ReturnValues: 'ALL_NEW' })),
        404,
        'Code not found or expired',
      );
      if (Attributes!.failures >= MAX_JOIN_FAILURES) {
        await db.send(new UpdateCommand({ TableName: TABLE, Key, UpdateExpression: 'SET #s = :burned REMOVE verifier, #w', ExpressionAttributeNames: names, ExpressionAttributeValues: { ':burned': 'burned' } }));
      }
      throw new HttpError(403, 'Wrong code.');
    }

    const pad = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `pad#${c.padId}` } }))).Item as PadItem | undefined;
    if (!pad || pad.expiresAt < Date.now()) throw new HttpError(410, 'This pad has ended.');
    // Single use: only one claim can flip open -> claimed. The wrapped key leaves the table with it.
    await conditional(
      db.send(new UpdateCommand({ TableName: TABLE, Key, UpdateExpression: 'SET #s = :claimed REMOVE verifier, #w', ConditionExpression: '#s = :open', ExpressionAttributeNames: names, ExpressionAttributeValues: { ':claimed': 'claimed', ':open': 'open' } })),
      404,
      'Code not found or expired',
    );
    const token = randomBytes(32).toString('hex');
    await db.send(new UpdateCommand({ TableName: TABLE, Key: { pk: pad.pk }, UpdateExpression: 'ADD tokens :t', ExpressionAttributeValues: { ':t': new Set([hash(token)]) } }));
    return { padId: pad.padId, token, wrapped: c.wrapped! };
  });

  // The built web app; any other non-API GET is a client-side route.
  app.register(fastifyStatic, {
    root: join(import.meta.dirname, '../../web/dist'),
    wildcard: false,
    setHeaders: (res, path) => path.includes('/assets/') && res.header('cache-control', 'public, max-age=31536000, immutable'),
  });
  app.setNotFoundHandler((req, reply) =>
    req.method === 'GET' && !req.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found' }),
  );

  return app;
}
