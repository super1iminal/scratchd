import { expect, it } from 'vitest';
import { PREVIEW_MAX, previewKind } from './preview';

const f = (name: string, type = '', size = 10) => ({ kind: 'file' as const, name, type, size });

it('picks a preview from MIME type or extension', () => {
  expect(previewKind(f('notes.md'))).toBe('markdown');
  expect(previewKind({ ...f('text.txt', 'text/plain'), kind: 'text' })).toBe('text');
  expect(previewKind(f('a.py'))).toBe('text');
  expect(previewKind(f('a.json', 'application/json'))).toBe('text');
  expect(previewKind(f('logo.svg', 'image/svg+xml'))).toBe('image');
  expect(previewKind(f('doc.PDF'))).toBe('pdf');
  expect(previewKind(f('clip.mp4', 'video/mp4'))).toBe('video');
  expect(previewKind(f('a.zip', 'application/zip'))).toBe(null);
  expect(previewKind(f('big.txt', 'text/plain', PREVIEW_MAX + 1))).toBe(null);
});
