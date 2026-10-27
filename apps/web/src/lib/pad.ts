import { CHUNK_SIZE, type PadInfo } from '@scratchd/shared';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { api } from './mockApi';
import { newPadKey, openChunk, openMeta, padKeys, sealChunk, sealMeta, type ItemMeta } from './crypto';

// What a device needs to reach a pad. Kept in sessionStorage: survives a reload of this
// tab, gone when the tab closes.
export interface Creds {
  padId: string;
  token: string;
  key: string; // hex pad key, never sent to the server
}

export const saveCreds = (c: Creds) => sessionStorage.setItem(`pad:${c.padId}`, JSON.stringify(c));
export const loadCreds = (padId: string): Creds | null => JSON.parse(sessionStorage.getItem(`pad:${padId}`) ?? 'null');
export const forgetCreds = (padId: string) => sessionStorage.removeItem(`pad:${padId}`);

// Uploads started in this tab, so the pad view can show their errors.
export const uploads = new Map<string, Promise<void>>();

export async function createPad(item: File | string): Promise<Creds> {
  const blob = typeof item === 'string' ? new Blob([item], { type: 'text/plain' }) : item;
  const meta: ItemMeta =
    typeof item === 'string'
      ? { kind: 'text', name: 'text.txt', type: 'text/plain', size: blob.size }
      : { kind: 'file', name: item.name, type: item.type, size: item.size };
  const raw = newPadKey();
  const keys = await padKeys(raw);
  const chunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
  const { padId, token } = await api.createPad({ meta: bytesToHex(await sealMeta(keys, meta)), size: blob.size, chunks });

  uploads.set(
    padId,
    (async () => {
      for (let i = 0; i < chunks; i++) {
        const data = new Uint8Array(await blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer());
        await api.putChunk(padId, token, i, await sealChunk(keys, i, i === chunks - 1, data));
      }
    })(),
  );

  const creds = { padId, token, key: bytesToHex(raw) };
  saveCreds(creds);
  return creds;
}

export async function loadPad(c: Creds): Promise<{ info: PadInfo; meta: ItemMeta }> {
  const info = await api.getPad(c.padId, c.token);
  return { info, meta: await openMeta(await padKeys(hexToBytes(c.key)), hexToBytes(info.meta)) };
}

// shortcut: holds the whole decrypted file in memory (Chrome pages big Blobs to disk, iOS
// Safari may run out near 1 GB); upgrade to streaming into a service-worker download if that bites.
export async function readItem(c: Creds, info: PadInfo, meta: ItemMeta): Promise<Blob> {
  const keys = await padKeys(hexToBytes(c.key));
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let i = 0; i < info.chunks; i++) {
    parts.push((await openChunk(keys, i, i === info.chunks - 1, await api.getChunk(c.padId, c.token, i))) as Uint8Array<ArrayBuffer>);
  }
  return new Blob(parts, { type: meta.type });
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export async function endPad(c: Creds) {
  forgetCreds(c.padId);
  await api.endPad(c.padId, c.token);
}
