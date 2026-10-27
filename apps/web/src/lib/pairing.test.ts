import { expect, it, vi } from 'vitest';
import { codeKeys } from './pairing';


it('derives the same verifier only from the same secret and salt', async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const a = await codeKeys('M4XPD', salt);
  expect((await codeKeys('M4XPD', salt)).verifier).toEqual(a.verifier);
  expect((await codeKeys('M4XPE', salt)).verifier).not.toEqual(a.verifier);
  expect((await codeKeys('M4XPD', crypto.getRandomValues(new Uint8Array(16)))).verifier).not.toEqual(a.verifier);
}, 20_000);
