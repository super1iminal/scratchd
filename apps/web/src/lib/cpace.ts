// CPace PAKE over ristretto255 + SHA-512, following draft-irtf-cfrg-cpace (initiator/responder
// mode, empty associated data). Both sides derive the same ISK only if they used the same password.
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToNumberLE, concatBytes } from '@noble/curves/utils.js';

const Point = ristretto255.Point;
const te = new TextEncoder();
const DSI = te.encode('CPaceRistretto255');
const CI = te.encode('scratchd-pair-v1'); // channel identifier
const S_IN_BYTES = 128; // SHA-512 block size

function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = [];
  let n = data.length;
  do {
    len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0)); // LEB128
    n >>= 7;
  } while (n > 0);
  return concatBytes(new Uint8Array(len), data);
}
const lvCat = (...parts: Uint8Array[]) => concatBytes(...parts.map(prependLen));

function generator(prs: Uint8Array, sid: Uint8Array) {
  const zpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return ristretto255_hasher.deriveToCurve!(sha512(lvCat(DSI, prs, new Uint8Array(zpad), CI, sid)));
}

function randomScalar(): bigint {
  for (;;) {
    const s = Point.Fn.create(bytesToNumberLE(crypto.getRandomValues(new Uint8Array(64))));
    if (s !== 0n) return s;
  }
}

export function cpaceStart(prs: Uint8Array, sid: Uint8Array) {
  const y = randomScalar();
  return { y, Y: generator(prs, sid).multiply(y).toBytes() };
}

// ya/yb are always the initiator's and responder's points, whichever side is calling.
export function cpaceFinish(y: bigint, peer: Uint8Array, ya: Uint8Array, yb: Uint8Array, sid: Uint8Array): Uint8Array {
  const K = Point.fromBytes(peer).multiply(y);
  if (K.is0()) throw new Error('Invalid peer point');
  const transcript = concatBytes(lvCat(ya, new Uint8Array()), lvCat(yb, new Uint8Array()));
  return sha512(concatBytes(lvCat(concatBytes(DSI, te.encode('_ISK')), sid, K.toBytes()), transcript));
}
