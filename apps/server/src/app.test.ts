import { beforeAll, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { buildApp } from './app.ts';
import { ensureDevResources } from './aws.ts';

const app = buildApp();
beforeAll(ensureDevResources);

async function api(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, token?: string) {
  const res = await app.inject({ method, url: `/api${url}`, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
}

async function newPad() {
  const { body } = await api('POST', '/pads', { meta: 'ab', size: 10, chunks: 1 });
  return body as { padId: string; token: string };
}

const channelBody = (verifier: string) => ({ salt: '0'.repeat(32), verifier, wrapped: 'c'.repeat(120) });

it('uploads, downloads, pairs and deletes a pad', async () => {
  const { padId, token } = await newPad();

  const sealed = randomBytes(26);
  const { body: part } = await api('GET', `/pads/${padId}/parts/0/url`, undefined, token);
  const put = await fetch(part.url, { method: 'PUT', body: sealed });
  expect(put.ok).toBe(true);
  expect((await api('POST', `/pads/${padId}/parts/0`, { etag: put.headers.get('etag') }, token)).status).toBe(204);
  expect((await api('GET', `/pads/${padId}`, undefined, token)).body.uploaded).toBe(1);

  const { body: dl } = await api('GET', `/pads/${padId}/url`, undefined, token);
  const got = await fetch(dl.url, { headers: { range: 'bytes=0-25' } });
  expect(Buffer.from(await got.arrayBuffer())).toEqual(sealed);

  const verifier = 'a'.repeat(64);
  const { body: chan } = await api('POST', `/pads/${padId}/channels`, channelBody(verifier), token);
  expect((await api('POST', `/channels/${chan.channelId}/claim`, { verifier: 'b'.repeat(64) })).status).toBe(403);
  const claim = await api('POST', `/channels/${chan.channelId}/claim`, { verifier });
  expect(claim.body.wrapped).toBe('c'.repeat(120));
  expect((await api('POST', `/channels/${chan.channelId}/claim`, { verifier })).status).toBe(404); // single use
  expect((await api('GET', `/channels/${chan.channelId}`)).body.status).toBe('claimed');
  expect((await api('GET', `/pads/${padId}`, undefined, claim.body.token)).status).toBe(200);

  expect((await api('DELETE', `/pads/${padId}`, undefined, claim.body.token)).status).toBe(204);
  expect((await api('GET', `/pads/${padId}`, undefined, token)).status).toBe(404);
});

it('burns a code after three wrong tries', async () => {
  const { padId, token } = await newPad();
  const verifier = 'a'.repeat(64);
  const { body: chan } = await api('POST', `/pads/${padId}/channels`, channelBody(verifier), token);
  for (let i = 0; i < 3; i++) expect((await api('POST', `/channels/${chan.channelId}/claim`, { verifier: 'b'.repeat(64) })).status).toBe(403);
  expect((await api('GET', `/channels/${chan.channelId}`)).body.status).toBe('burned');
  expect((await api('POST', `/channels/${chan.channelId}/claim`, { verifier })).status).toBe(404);
});

it('rejects wrong tokens and bad input', async () => {
  const { padId } = await newPad();
  expect((await api('GET', `/pads/${padId}`, undefined, 'nope')).status).toBe(404);
  expect((await api('POST', '/pads', { meta: 'ab', size: 2 ** 31, chunks: 1 })).status).toBe(400);
  expect((await api('POST', '/pads', { meta: 'ab', size: 10, chunks: 2 })).status).toBe(400);
});
