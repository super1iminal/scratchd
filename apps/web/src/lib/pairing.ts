// Device pairing over the server relay. The code's last 5 chars are a CPace password: the
// server relays curve points but can't learn the pad key or test guesses offline.
//
// Sender (has the pad)            server              Joiner (typed the code)
//   openChannel(sid, Ya)   ─────►  stores
//                                  getChannel   ◄───  start CPace, Yb, tag
//   verify tag ◄── join(Yb, tag) ◄────────────────── join
//   approve(seal(padKey)) ───────► mints token ────►  open(sealed) = padKey
import type { JoinEvent, JoinResult } from '@scratchd/shared';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { cpaceFinish, cpaceStart } from './cpace';
import { CHANNEL_LENGTH, CODE_LENGTH, randomCode, randomId } from './code';
import { aesKey, open, seal } from './crypto';
import { api } from './mockApi';
import { saveCreds, type Creds } from './pad';

const te = new TextEncoder();
const JOIN_TIMEOUT_MS = 30_000;

async function sessionKeys(isk: Uint8Array) {
  return {
    tag: hkdf(sha256, isk, undefined, te.encode('scratchd pair v1 confirm'), 32),
    aes: await aesKey(isk, 'scratchd pair v1 seal'),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i % b.length];
  return diff === 0;
}

export type ShareEvent = 'paired' | 'wrong' | 'burned';

export async function startSharing(c: Creds, onEvent: (e: ShareEvent) => void) {
  const secret = randomCode(CODE_LENGTH - CHANNEL_LENGTH);
  const sid = crypto.getRandomValues(new Uint8Array(16));
  const a = cpaceStart(te.encode(secret), sid);
  const { channelId, expiresAt } = await api.openChannel(c.padId, c.token, bytesToHex(sid), bytesToHex(a.Y));

  const stop = api.subscribe(`channel:${channelId}`, async (e: JoinEvent) => {
    try {
      const yb = hexToBytes(e.yb);
      const keys = await sessionKeys(cpaceFinish(a.y, yb, a.Y, yb, sid));
      if (!sameBytes(keys.tag, hexToBytes(e.tb))) throw new Error('wrong code');
      await api.approve(channelId, c.token, e.joinId, bytesToHex(await seal(keys.aes, hexToBytes(c.key))));
      stop();
      onEvent('paired');
    } catch {
      const { burned } = await api.reject(channelId, c.token, e.joinId).catch(() => ({ burned: true }));
      if (burned) stop();
      onEvent(burned ? 'burned' : 'wrong');
    }
  });
  return { code: channelId + secret, expiresAt, stop };
}

export async function joinWithCode(code: string): Promise<Creds> {
  const channelId = code.slice(0, CHANNEL_LENGTH);
  const { sid, ya } = await api.getChannel(channelId);
  const b = cpaceStart(te.encode(code.slice(CHANNEL_LENGTH)), hexToBytes(sid));
  const keys = await sessionKeys(cpaceFinish(b.y, hexToBytes(ya), hexToBytes(ya), b.Y, hexToBytes(sid)));

  const joinId = randomId();
  let stop = () => {};
  const result = new Promise<JoinResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The other device didn't answer. Is scratchd still open there?")), JOIN_TIMEOUT_MS);
    stop = api.subscribe(`join:${joinId}`, (r: JoinResult) => (clearTimeout(timer), resolve(r)));
  });
  result.catch(() => {}); // awaited below; avoids an unhandled rejection if join() throws first
  try {
    await api.join(channelId, joinId, bytesToHex(b.Y), bytesToHex(keys.tag));
    const r = await result;
    if (!r.ok) throw new Error('Wrong code.');
    const creds = { padId: r.padId!, token: r.token!, key: bytesToHex(await open(keys.aes, hexToBytes(r.sealed!))) };
    saveCreds(creds);
    return creds;
  } finally {
    stop();
  }
}
