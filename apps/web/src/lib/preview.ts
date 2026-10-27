import type { ItemMeta } from './crypto';

// Previews decrypt the whole item into memory, so big files only get Download.
export const PREVIEW_MAX = 25_000_000;
const TEXT_EXT = /\.(txt|csv|tsv|log|json|ya?ml|toml|ini|xml|html?|css|sql|sh|js|jsx|ts|tsx|py|go|rs|java|kt|c|cpp|h|cs|rb|php)$/i;

export type PreviewKind = 'markdown' | 'text' | 'image' | 'pdf' | 'video' | 'audio' | null;

export function previewKind(m: ItemMeta): PreviewKind {
  if (m.size > PREVIEW_MAX) return null;
  for (const k of ['image', 'video', 'audio'] as const) if (m.type.startsWith(`${k}/`)) return k;
  if (m.kind === 'file' && (m.type === 'text/markdown' || /\.(md|markdown)$/i.test(m.name))) return 'markdown';
  if (m.type === 'application/pdf' || /\.pdf$/i.test(m.name)) return 'pdf';
  // OSes often report no MIME type for .md, code, etc., so fall back to the extension.
  if (m.kind === 'text' || m.type.startsWith('text/') || /json|xml|javascript/.test(m.type) || TEXT_EXT.test(m.name)) return 'text';
  return null;
}
