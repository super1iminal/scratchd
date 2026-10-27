// API contract shared by the web app and the server.
// Binary values (ciphertext, curve points, tags) travel as hex strings.

export const PAD_TTL_MS = 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const MAX_FILE_BYTES = 1024 ** 3;
// Plaintext bytes per encrypted chunk; one chunk = one S3 multipart part (min 5 MiB).
export const CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_JOIN_FAILURES = 3;

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

// Sent to the device that opened the channel when someone enters its code.
export interface JoinEvent {
  type: 'join';
  joinId: string;
  yb: string;
  tb: string;
}

// Sent to the joining device once the code owner accepts or rejects it.
export interface JoinResult {
  type: 'result';
  ok: boolean;
  padId?: string;
  token?: string;
  sealed?: string; // pad key encrypted under the PAKE session key
}

export interface Api {
  createPad(input: CreatePadInput): Promise<{ padId: string; token: string; expiresAt: number }>;
  putChunk(padId: string, token: string, index: number, data: Uint8Array): Promise<void>;
  getPad(padId: string, token: string): Promise<PadInfo>;
  getChunk(padId: string, token: string, index: number): Promise<Uint8Array>;
  endPad(padId: string, token: string): Promise<void>;

  openChannel(padId: string, token: string, sid: string, ya: string): Promise<{ channelId: string; expiresAt: number }>;
  getChannel(channelId: string): Promise<{ sid: string; ya: string }>;
  join(channelId: string, joinId: string, yb: string, tb: string): Promise<void>;
  approve(channelId: string, token: string, joinId: string, sealed: string): Promise<void>;
  reject(channelId: string, token: string, joinId: string): Promise<{ burned: boolean }>;

  // Topics: `pad:<padId>` (PadEvent), `channel:<channelId>` (JoinEvent), `join:<joinId>` (JoinResult).
  subscribe(topic: string, fn: (event: any) => void): () => void;
}
