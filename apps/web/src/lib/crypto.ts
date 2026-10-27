// Item encryption. Each pad has a random 32-byte key that only devices hold; the server
// stores ciphertext. Files are encrypted in CHUNK_SIZE pieces because Web Crypto's AES-GCM
// can't stream, and a 1 GB one-shot encrypt would need ~2 GB of RAM.
const te = new TextEncoder();
const td = new TextDecoder();
// Our bytes never live in a SharedArrayBuffer; TS just can't prove it for library outputs.
const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

export interface ItemMeta {
  kind: 'text' | 'file';
  name: string;
  type: string;
  size: number;
}

export interface PadKeys {
  meta: CryptoKey;
  chunk: CryptoKey;
}

export const newPadKey = () => crypto.getRandomValues(new Uint8Array(32));

export async function aesKey(raw: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', buf(raw), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: te.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Separate subkeys so the random meta nonce can never collide with a chunk nonce.
export const padKeys = async (raw: Uint8Array): Promise<PadKeys> => ({
  meta: await aesKey(raw, 'scratchd meta v1'),
  chunk: await aesKey(raw, 'scratchd chunk v1'),
});

// Output: 12-byte random IV || ciphertext+tag.
export async function seal(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf(data)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function open(key: CryptoKey, sealed: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(sealed.subarray(0, 12)) }, key, buf(sealed.subarray(12))));
}

export const sealMeta = (keys: PadKeys, meta: ItemMeta) => seal(keys.meta, te.encode(JSON.stringify(meta)));
export const openMeta = async (keys: PadKeys, sealed: Uint8Array): Promise<ItemMeta> => JSON.parse(td.decode(await open(keys.meta, sealed)));

// Nonce = chunk index; AAD = "is last chunk", so the server can't reorder, swap or truncate chunks.
function chunkParams(index: number, isLast: boolean): AesGcmParams {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return { name: 'AES-GCM', iv, additionalData: new Uint8Array([isLast ? 1 : 0]) };
}

export async function sealChunk(keys: PadKeys, index: number, isLast: boolean, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.encrypt(chunkParams(index, isLast), keys.chunk, buf(data)));
}

export async function openChunk(keys: PadKeys, index: number, isLast: boolean, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt(chunkParams(index, isLast), keys.chunk, buf(data)));
}
