import { SEALED_CHUNK_SIZE, type Api, type ChannelEvent, type PadEvent, type PadInfo } from '@scratchd/shared';

const POLL_MS = 2000;

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

// Polls instead of holding sockets, so any number of server tasks can answer.
function poll(tick: (stop: () => void) => Promise<void>) {
  let stopped = false;
  const stop = () => void (stopped = true);
  (async () => {
    while (!stopped) {
      await tick(stop).catch(() => {}); // network blips: try again next round
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
  return stop;
}

export const api: Api = {
  createPad: (input) => call('POST', '/pads', input),

  async putChunk(padId, token, index, data) {
    const { url } = await call<{ url: string }>('GET', `/pads/${padId}/parts/${index}/url`, undefined, token);
    const res = await fetch(url, { method: 'PUT', body: data as Uint8Array<ArrayBuffer> });
    const etag = res.headers.get('etag');
    if (!res.ok || !etag) throw new Error(`Upload failed (${res.status})`);
    await call('POST', `/pads/${padId}/parts/${index}`, { etag }, token);
  },

  getPad: (padId, token) => call('GET', `/pads/${padId}`, undefined, token),

  async getChunk(padId, token, index) {
    // A fresh URL per chunk: signed URLs expire, and a 1 GB download can outlast one.
    const { url } = await call<{ url: string }>('GET', `/pads/${padId}/url`, undefined, token);
    const start = index * SEALED_CHUNK_SIZE;
    const res = await fetch(url, { headers: { range: `bytes=${start}-${start + SEALED_CHUNK_SIZE - 1}` } });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },

  endPad: (padId, token) => call('DELETE', `/pads/${padId}`, undefined, token),

  openChannel: (padId, token, salt, verifier, wrapped) => call('POST', `/pads/${padId}/channels`, { salt, verifier, wrapped }, token),
  getChannel: (channelId) => call('GET', `/channels/${channelId}`),
  claim: (channelId, verifier) => call('POST', `/channels/${channelId}/claim`, { verifier }),

  watchPad(padId, token, fn: (e: PadEvent) => void) {
    let uploaded = -1;
    return poll(async (stop) => {
      try {
        const info = await call<PadInfo>('GET', `/pads/${padId}`, undefined, token);
        if (info.uploaded !== uploaded) fn({ type: 'progress', uploaded: (uploaded = info.uploaded) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) (stop(), fn({ type: 'ended' }));
        else throw e;
      }
    });
  },

  watchChannel(channelId, fn: (e: ChannelEvent) => void) {
    return poll(async (stop) => {
      const { status } = await call<{ status: string }>('GET', `/channels/${channelId}`);
      if (status === 'claimed' || status === 'burned') (stop(), fn({ type: status }));
    });
  },
};
