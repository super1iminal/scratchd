import { ALPHABET, CODE_LENGTH } from '@scratchd/shared';

// Uppercases and drops anything outside the alphabet (dashes, spaces).
export const normalizeCode = (input: string) =>
  [...input.toUpperCase()].filter((c) => ALPHABET.includes(c)).join('').slice(0, CODE_LENGTH);

export const formatCode = (code: string) => (code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);
