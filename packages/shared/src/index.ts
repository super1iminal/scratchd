// API contract shared by the web app and the server.
// Binary values (ciphertext, salts, verifiers) travel as hex strings.

export const PAD_TTL_MS = 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_FILE_BYTES = 1024 ** 3;
// Plaintext bytes per encrypted chunk; one chunk = one S3 multipart part (min 5 MiB).
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const SEALED_CHUNK_SIZE = CHUNK_SIZE + 16; // + AES-GCM tag
export const MAX_CODE_TRIES = 3; // a wrong third try burns the code
export const MAX_DEVICES = 20; // per pad; keeps its DynamoDB row far under the 400 KB limit

// Pairing codes: 8 chars from an alphabet without look-alikes (no 0/O, 1/I/L, U).
// The first 3 chars name the server-side channel; the last 5 are a secret that never leaves the devices.
export const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
export const CHANNEL_LENGTH = 3;

export function randomCode(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      // 240 = 8 * 30: rejecting the tail keeps every character equally likely.
      if (b < 240 && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

export interface CreatePadInput {
  meta: string; // encrypted ItemMeta
  size: number; // plaintext bytes
  chunks: number;
}

export interface PadInfo extends CreatePadInput {
  padId: string;
  uploaded: number; // chunks stored so far
  expiresAt: number;
}

export interface PadEvent {
  type: 'progress' | 'ended';
  uploaded?: number;
}

// Sent to the device that opened the channel.
export interface ChannelEvent {
  type: 'claimed' | 'burned'; // code used by another device, or killed after too many wrong tries
}

export type ChannelStatus = 'open' | ChannelEvent['type'];

export interface Api {
  createPad(input: CreatePadInput): Promise<{ padId: string; token: string; expiresAt: number }>;
  putChunk(padId: string, token: string, index: number, data: Uint8Array): Promise<void>;
  getPad(padId: string, token: string): Promise<PadInfo>;
  getChunk(padId: string, token: string, index: number): Promise<Uint8Array>;
  endPad(padId: string, token: string): Promise<void>;

  // Pairing by key wrapping: `wrapped` is the pad key encrypted under Argon2id(code secret);
  // `verifier` is derived from the same secret and gates who may fetch `wrapped`.
  openChannel(padId: string, token: string, salt: string, verifier: string, wrapped: string): Promise<{ channelId: string; expiresAt: number }>;
  getChannel(channelId: string): Promise<{ salt: string; status: ChannelStatus }>;
  claim(channelId: string, verifier: string): Promise<{ padId: string; token: string; wrapped: string }>;

  // Change feeds; each returns a stop function.
  watchPad(padId: string, token: string, fn: (e: PadEvent) => void): () => void;
  watchChannel(channelId: string, fn: (e: ChannelEvent) => void): () => void;
}
