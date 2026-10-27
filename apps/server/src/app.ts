import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';
import {
  ALPHABET,
  CHANNEL_LENGTH,
  CHUNK_SIZE,
  CODE_TTL_MS,
  MAX_CODE_TRIES,
  MAX_DEVICES,
  MAX_FILE_BYTES,
  PAD_TTL_MS,
  SEALED_CHUNK_SIZE,
  randomCode,
  type ChannelStatus,
  type CreatePadInput,
  type PadInfo,
} from '@scratchd/shared';
import { BUCKET, TABLE, db, fileOrigin, s3, signedUrl } from './aws.ts';

// A brake on storage and download costs if someone abuses the service. Counts declared sizes.
const DAILY_UPLOAD_BYTES = Number(process.env.DAILY_UPLOAD_BYTES ?? 25 * 1024 ** 3);

// One DynamoDB table, keyed by `pad#<id>`, `chan#<id>` or `day#<yyyy-mm-dd>`. `ttl` (epoch seconds)
// lets DynamoDB delete old rows eventually; reads still check expiresAt because TTL can lag by a day or two.
interface PadItem extends PadInfo {
  pk: string;
  tokens: Set<string>; // SHA-256 of each device's token
  chans: Record<string, string>; // token hash -> that device's current code channel
  uploadId: string;
  ttl: number;
}
interface ChannelItem {
  pk: string;
  padId: string;
  salt: string;
  verifier?: string; // removed once the code is used or burned
  wrapped?: string;
  tries: number;
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
const bearerHash = (req: FastifyRequest) => hash(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
const objectKey = (padId: string) => `pads/${padId}`;
const epochSeconds = (ms: number) => Math.ceil(ms / 1000);
const hex = (length: number) => ({ type: 'string', pattern: `^[0-9a-f]{${length}}$` });
const body = (properties: Record<string, object>) => ({ type: 'object', required: Object.keys(properties), additionalProperties: false, properties });
const padParams = { type: 'object', properties: { padId: hex(32), index: { type: 'integer', minimum: 0 } } };
const channelParams = { type: 'object', properties: { channelId: { type: 'string', pattern: `^[${ALPHABET}]{${CHANNEL_LENGTH}}$` } } };
// Bytes S3 should hold for upload part n (1-based): full sealed chunks, then the remainder + tag.
const partSize = (pad: PadItem, n: number) => (n < pad.chunks ? SEALED_CHUNK_SIZE : pad.size - (pad.chunks - 1) * CHUNK_SIZE + 16);

// Only this site's own scripts may run: a pad key in sessionStorage is worth stealing.
// No HSTS header: the whole .dev TLD is HSTS-preloaded in browsers.
const securityHeaders = {
  'content-security-policy': [
    "default-src 'self'",
    `connect-src 'self' ${fileOrigin}`,
    "img-src 'self' blob: data:",
    'media-src blob:',
    "style-src 'self' 'unsafe-inline'", // pdf.js text layers and markdown tables set inline styles
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

// A lost race on a conditional write means someone else changed the row first.
const conditional = <T>(p: Promise<T>, status: number, message: string) =>
  p.catch((e) => {
    throw e instanceof ConditionalCheckFailedException ? new HttpError(status, message) : e;
  });

async function authedPad(req: FastifyRequest): Promise<PadItem> {
  const { padId } = req.params as { padId: string };
  const pad = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `pad#${padId}` } }))).Item as PadItem | undefined;
  if (!pad || pad.expiresAt < Date.now() || !pad.tokens.has(bearerHash(req))) throw new HttpError(404, 'Pad not found');
  return pad;
}

async function openChannel(req: FastifyRequest): Promise<ChannelItem> {
  const { channelId } = req.params as { channelId: string };
  const c = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `chan#${channelId}` } }))).Item as ChannelItem | undefined;
  if (!c || c.expiresAt < Date.now()) throw new HttpError(404, 'Code not found or expired');
  return c;
}

// Deletes a code with its wrapped key, unless the channel id has since gone to another pad.
const dropChannel = (channelId: string, padId: string) =>
  db
    .send(new DeleteCommand({ TableName: TABLE, Key: { pk: `chan#${channelId}` }, ConditionExpression: 'padId = :p', ExpressionAttributeValues: { ':p': padId } }))
    .catch((e) => {
      if (!(e instanceof ConditionalCheckFailedException)) throw e;
    });

async function removePad(pad: PadItem) {
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: pad.pk } }));
  const Key = objectKey(pad.padId);
  await Promise.all([
    pad.uploaded === pad.chunks
      ? s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }))
      : s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key, UploadId: pad.uploadId })),
    ...Object.values(pad.chans).map((id) => dropChannel(id, pad.padId)),
  ]);
}

const padInfo = ({ padId, meta, size, chunks, uploaded, expiresAt }: PadItem): PadInfo => ({ padId, meta, size, chunks, uploaded, expiresAt });

export function buildApp() {
  const app = Fastify({ logger: true });

  app.addHook('onRequest', async (_req, reply) => void reply.headers(securityHeaders));

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
    const now = Date.now();
    await conditional(
      db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: `day#${new Date(now).toISOString().slice(0, 10)}` },
          UpdateExpression: 'SET #ttl = :ttl ADD #b :size',
          ConditionExpression: 'attribute_not_exists(#b) OR #b <= :room',
          ExpressionAttributeNames: { '#ttl': 'ttl', '#b': 'bytes' },
          ExpressionAttributeValues: { ':size': size, ':room': DAILY_UPLOAD_BYTES - size, ':ttl': epochSeconds(now + 2 * PAD_TTL_MS) },
        }),
      ),
      503,
      'scratchd is full for today. Try again tomorrow.',
    );
    const padId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: objectKey(padId) }));
    const expiresAt = now + PAD_TTL_MS;
    const item: PadItem = { pk: `pad#${padId}`, padId, meta, size, chunks, uploaded: 0, expiresAt, ttl: epochSeconds(expiresAt), tokens: new Set([hash(token)]), chans: {}, uploadId: UploadId! };
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

  app.post('/api/pads/:padId/parts/:index', { schema: { params: padParams } }, async (req, reply) => {
    const pad = await authedPad(req);
    const { index } = req.params as { index: number };
    if (index !== pad.uploaded || index >= pad.chunks) throw new HttpError(409, 'Upload parts in order');
    const Key = objectKey(pad.padId);
    const { Parts = [] } = await s3.send(new ListPartsCommand({ Bucket: BUCKET, Key, UploadId: pad.uploadId }));
    if (!Parts.some((p) => p.PartNumber === index + 1)) throw new HttpError(409, 'Part not uploaded yet');
    // Signed URLs can't bound a PUT's size, so check what actually landed, including earlier parts
    // re-sent to a URL that was still valid.
    if (Parts.some((p) => p.PartNumber! > index + 1 || p.Size !== partSize(pad, p.PartNumber!))) {
      await removePad(pad);
      throw new HttpError(400, 'Upload was the wrong size');
    }
    if (index === pad.chunks - 1) {
      const MultipartUpload = { Parts: Parts.map(({ ETag, PartNumber }) => ({ ETag, PartNumber })) };
      await s3.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key, UploadId: pad.uploadId, MultipartUpload }));
    }
    await conditional(
      db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { pk: pad.pk },
          UpdateExpression: 'SET uploaded = :next',
          ConditionExpression: 'uploaded = :index',
          ExpressionAttributeValues: { ':next': index + 1, ':index': index },
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
    await removePad(await authedPad(req));
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
      const item: ChannelItem = { pk: `chan#${channelId}`, padId: pad.padId, salt, verifier, wrapped, tries: 0, status: 'open', expiresAt, ttl: epochSeconds(expiresAt) };
      try {
        await db.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now', ExpressionAttributeValues: { ':now': now } }));
      } catch (e) {
        if (e instanceof ConditionalCheckFailedException) continue;
        throw e;
      }
      // One live code per device: the one it replaces takes its wrapped key with it.
      const me = bearerHash(req);
      const { Attributes } = await db.send(
        new UpdateCommand({ TableName: TABLE, Key: { pk: pad.pk }, UpdateExpression: 'SET chans.#me = :id', ExpressionAttributeNames: { '#me': me }, ExpressionAttributeValues: { ':id': channelId }, ReturnValues: 'UPDATED_OLD' }),
      );
      const previous = Attributes?.chans?.[me];
      if (previous && previous !== channelId) await dropChannel(previous, pad.padId);
      return { channelId, expiresAt };
    }
    throw new HttpError(503, 'No free codes right now. Try again.');
  });

  app.get('/api/channels/:channelId', { schema: { params: channelParams } }, async (req) => {
    const c = await openChannel(req);
    return { salt: c.salt, status: c.status };
  });

  app.post('/api/channels/:channelId/claim', { schema: { params: channelParams, body: body({ verifier: hex(64) }) } }, async (req) => {
    const { channelId } = req.params as { channelId: string };
    const { verifier } = req.body as { verifier: string };
    const Key = { pk: `chan#${channelId}` };
    const names = { '#s': 'status', '#w': 'wrapped' };

    // Count the try before checking it, so parallel guesses can't get past the limit.
    const { Attributes } = await conditional(
      db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key,
          UpdateExpression: 'ADD tries :one',
          ConditionExpression: '#s = :open AND tries < :max AND expiresAt > :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':one': 1, ':open': 'open', ':max': MAX_CODE_TRIES, ':now': Date.now() },
          ReturnValues: 'ALL_NEW',
        }),
      ),
      404,
      'Code not found or expired',
    );
    const c = Attributes as ChannelItem;

    if (!timingSafeEqual(Buffer.from(c.verifier!, 'hex'), Buffer.from(verifier, 'hex'))) {
      if (c.tries >= MAX_CODE_TRIES) {
        await conditional(
          db.send(new UpdateCommand({ TableName: TABLE, Key, UpdateExpression: 'SET #s = :burned REMOVE verifier, #w', ConditionExpression: '#s = :open', ExpressionAttributeNames: names, ExpressionAttributeValues: { ':burned': 'burned', ':open': 'open' } })),
          403,
          'Wrong code.',
        );
      }
      throw new HttpError(403, 'Wrong code.');
    }

    const pad = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `pad#${c.padId}` } }))).Item as PadItem | undefined;
    if (!pad || pad.expiresAt < Date.now()) throw new HttpError(410, 'This pad has ended.');
    // shortcut: a few simultaneous claims can overshoot the cap slightly; it only bounds the row size.
    if (pad.tokens.size >= MAX_DEVICES) throw new HttpError(409, 'This pad is open on too many devices.');
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
