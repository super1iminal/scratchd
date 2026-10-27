// Pairing codes: 8 chars from an alphabet without look-alikes (no 0/O, 1/I/L, U).
// The first 3 chars name the server-side channel; the last 5 are the PAKE password,
// which never leaves the two devices.
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

export const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// Uppercases and drops anything outside the alphabet (dashes, spaces).
export const normalizeCode = (input: string) =>
  [...input.toUpperCase()].filter((c) => ALPHABET.includes(c)).join('').slice(0, CODE_LENGTH);

export const formatCode = (code: string) => (code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);
