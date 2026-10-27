// In-browser stand-in for the server: state lives in IndexedDB and events cross tabs over
// BroadcastChannel, so two tabs behave like two devices. Replaced by an HTTP client later.
import { CODE_TTL_MS, MAX_JOIN_FAILURES, PAD_TTL_MS, type Api, type PadInfo } from '@scratchd/shared';
import { randomCode, randomId } from './code';

interface PadRecord extends PadInfo {
  tokens: string[];
}
interface ChannelRecord {
  channelId: string;
  padId: string;
  sid: string;
  ya: string;
  expiresAt: number;
  failures: number;
}

const dbp = new Promise<IDBDatabase>((resolve, reject) => {
  const req = indexedDB.open('scratchd-mock', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function db<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const store = (await dbp).transaction('kv', mode).objectStore('kv');
  return new Promise((resolve, reject) => {
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const get = <T>(key: string) => db<T | undefined>('readonly', (s) => s.get(key));
const put = (key: string, value: unknown) => db('readwrite', (s) => s.put(value, key));
const del = (key: string) => db('readwrite', (s) => s.delete(key));

const bc = new BroadcastChannel('scratchd-mock');
const listeners = new Map<string, Set<(e: any) => void>>();
bc.onmessage = (m) => listeners.get(m.data.topic)?.forEach((fn) => fn(m.data.event));
function emit(topic: string, event: unknown) {
  bc.postMessage({ topic, event });
  listeners.get(topic)?.forEach((fn) => fn(event));
}

async function pad(padId: string, token: string): Promise<PadRecord> {
  const p = await get<PadRecord>(`pad:${padId}`);
  if (!p || p.expiresAt < Date.now() || !p.tokens.includes(token)) throw new Error('Pad not found');
  return p;
}
async function channel(channelId: string): Promise<ChannelRecord> {
  const c = await get<ChannelRecord>(`chan:${channelId}`);
  if (!c || c.expiresAt < Date.now()) throw new Error('Code not found or expired');
  return c;
}

export const api: Api = {
  async createPad(input) {
    const p: PadRecord = { ...input, padId: randomId(), uploaded: 0, expiresAt: Date.now() + PAD_TTL_MS, tokens: [randomId()] };
    await put(`pad:${p.padId}`, p);
    return { padId: p.padId, token: p.tokens[0], expiresAt: p.expiresAt };
  },
  async putChunk(padId, token, index, data) {
    const p = await pad(padId, token);
    await put(`chunk:${padId}:${index}`, data);
    p.uploaded = index + 1;
    await put(`pad:${padId}`, p);
    emit(`pad:${padId}`, { type: 'progress', uploaded: p.uploaded });
  },
  async getPad(padId, token) {
    const { tokens: _, ...info } = await pad(padId, token);
    return info;
  },
  async getChunk(padId, token, index) {
    await pad(padId, token);
    const data = await get<Uint8Array>(`chunk:${padId}:${index}`);
    if (!data) throw new Error('Chunk not uploaded');
    return data;
  },
  async endPad(padId, token) {
    const p = await pad(padId, token);
    for (let i = 0; i < p.chunks; i++) await del(`chunk:${padId}:${i}`);
    await del(`pad:${padId}`);
    emit(`pad:${padId}`, { type: 'ended' });
  },

  async openChannel(padId, token, sid, ya) {
    await pad(padId, token);
    let channelId: string;
    do channelId = randomCode(3);
    while (await get(`chan:${channelId}`));
    const c: ChannelRecord = { channelId, padId, sid, ya, expiresAt: Date.now() + CODE_TTL_MS, failures: 0 };
    await put(`chan:${channelId}`, c);
    return { channelId, expiresAt: c.expiresAt };
  },
  async getChannel(channelId) {
    const { sid, ya } = await channel(channelId);
    return { sid, ya };
  },
  async join(channelId, joinId, yb, tb) {
    await channel(channelId);
    emit(`channel:${channelId}`, { type: 'join', joinId, yb, tb });
  },
  async approve(channelId, token, joinId, sealed) {
    const c = await channel(channelId);
    const p = await pad(c.padId, token);
    const newToken = randomId();
    p.tokens.push(newToken);
    await put(`pad:${p.padId}`, p);
    await del(`chan:${channelId}`); // codes are single-use
    emit(`join:${joinId}`, { type: 'result', ok: true, padId: p.padId, token: newToken, sealed });
  },
  async reject(channelId, token, joinId) {
    const c = await channel(channelId);
    await pad(c.padId, token);
    c.failures++;
    const burned = c.failures >= MAX_JOIN_FAILURES;
    await (burned ? del(`chan:${channelId}`) : put(`chan:${channelId}`, c));
    emit(`join:${joinId}`, { type: 'result', ok: false });
    return { burned };
  },

  subscribe(topic, fn) {
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic)!.add(fn);
    return () => listeners.get(topic)!.delete(fn);
  },
};
