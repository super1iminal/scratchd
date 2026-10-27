import { describe, expect, it } from 'vitest';
import { cpaceFinish, cpaceStart } from './cpace';
import { newPadKey, openChunk, openMeta, padKeys, sealChunk, sealMeta } from './crypto';

const te = new TextEncoder();

describe('cpace', () => {
  const sid = crypto.getRandomValues(new Uint8Array(16));

  it('agrees on a key when both sides use the same password', () => {
    const a = cpaceStart(te.encode('M4XPD'), sid);
    const b = cpaceStart(te.encode('M4XPD'), sid);
    expect(cpaceFinish(a.y, b.Y, a.Y, b.Y, sid)).toEqual(cpaceFinish(b.y, a.Y, a.Y, b.Y, sid));
  });

  it('disagrees when the passwords differ', () => {
    const a = cpaceStart(te.encode('M4XPD'), sid);
    const b = cpaceStart(te.encode('M4XPE'), sid);
    expect(cpaceFinish(a.y, b.Y, a.Y, b.Y, sid)).not.toEqual(cpaceFinish(b.y, a.Y, a.Y, b.Y, sid));
  });

  it('rejects the identity point', () => {
    const a = cpaceStart(te.encode('M4XPD'), sid);
    expect(() => cpaceFinish(a.y, new Uint8Array(32), a.Y, new Uint8Array(32), sid)).toThrow();
  });
});

describe('item encryption', async () => {
  const keys = await padKeys(newPadKey());

  it('round-trips meta and chunks', async () => {
    const meta = { kind: 'file' as const, name: 'a.bin', type: '', size: 3 };
    expect(await openMeta(keys, await sealMeta(keys, meta))).toEqual(meta);
    const sealed = await sealChunk(keys, 2, true, new Uint8Array([1, 2, 3]));
    expect(await openChunk(keys, 2, true, sealed)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a moved or truncated chunk', async () => {
    const sealed = await sealChunk(keys, 0, false, new Uint8Array([1]));
    await expect(openChunk(keys, 1, false, sealed)).rejects.toThrow(); // reordered
    await expect(openChunk(keys, 0, true, sealed)).rejects.toThrow(); // presented as last
  });

  it('rejects another pad key', async () => {
    const other = await padKeys(newPadKey());
    await expect(openChunk(other, 0, true, await sealChunk(keys, 0, true, new Uint8Array([1])))).rejects.toThrow();
  });
});
