// Device pairing by key wrapping. A code's first 3 chars name a server-side channel; the last 5
// are a secret that never leaves the devices. The sender stores the pad key encrypted under
// Argon2id(secret), so its tab can close right away. The server hands that blob only to someone
// who proves the secret (3 tries). Accepted trade-off: whoever controls the server could
// brute-force the 5 chars offline while the code is live (5 min).
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { CHANNEL_LENGTH, CODE_LENGTH, randomCode } from '@scratchd/shared';
import { aesKey, open, seal } from './crypto';
import { api } from './api';
import { saveCreds, type Creds } from './pad';

const te = new TextEncoder();

// ~0.5 s on a desktop, a few seconds on a phone; it's what makes offline guessing slow.
export async function codeKeys(secret: string, salt: Uint8Array) {
  const k = await argon2idAsync(secret, salt, { m: 65536, t: 3, p: 1, dkLen: 32 });
  return {
    verifier: hkdf(sha256, k, undefined, te.encode('scratchd pair v2 verify'), 32),
    wrap: await aesKey(k, 'scratchd pair v2 wrap'),
  };
}

export async function startSharing(c: Creds) {
  const secret = randomCode(CODE_LENGTH - CHANNEL_LENGTH);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keys = await codeKeys(secret, salt);
  const wrapped = await seal(keys.wrap, hexToBytes(c.key));
  const { channelId, expiresAt } = await api.openChannel(c.padId, c.token, bytesToHex(salt), bytesToHex(keys.verifier), bytesToHex(wrapped));
  return { code: channelId + secret, channelId, expiresAt };
}

export async function joinWithCode(code: string): Promise<Creds> {
  const channelId = code.slice(0, CHANNEL_LENGTH);
  const { salt, status } = await api.getChannel(channelId);
  if (status !== 'open') throw new Error('Code not found or expired');
  const keys = await codeKeys(code.slice(CHANNEL_LENGTH), hexToBytes(salt));
  const r = await api.claim(channelId, bytesToHex(keys.verifier));
  const creds = { padId: r.padId, token: r.token, key: bytesToHex(await open(keys.wrap, hexToBytes(r.wrapped))) };
  saveCreds(creds);
  return creds;
}
