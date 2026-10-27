import { useEffect, useMemo, useState } from 'react';
import type { PadEvent, PadInfo } from '@scratchd/shared';
import type { ItemMeta } from '../lib/crypto';
import { api } from '../lib/mockApi';
import { download, endPad, forgetCreds, loadCreds, loadPad, readItem, uploads, type Creds } from '../lib/pad';
import { errorMessage, formatBytes, navigate, useNow } from '../lib/ui';
import { freshPads } from './Home';
import { SharePanel } from './SharePanel';
import { Message, Shell } from './Shell';

const PREVIEW_MAX = 25_000_000;

export function PadView({ padId }: { padId: string }) {
  const creds = useMemo(() => loadCreds(padId), [padId]);
  const [pad, setPad] = useState<{ info: PadInfo; meta: ItemMeta } | null>(null);
  const [gone, setGone] = useState(creds ? '' : "This pad isn't open on this device.");
  const [uploadError, setUploadError] = useState('');
  const now = useNow(30_000);

  useEffect(() => {
    if (!creds) return;
    loadPad(creds).then(setPad, () => setGone('This pad has ended or expired.'));
    uploads.get(padId)?.catch((e) => setUploadError(errorMessage(e)));
    return api.subscribe(`pad:${padId}`, (e: PadEvent) => {
      if (e.type === 'ended') {
        forgetCreds(padId);
        setGone('This pad was ended.');
      } else setPad((p) => p && { ...p, info: { ...p.info, uploaded: e.uploaded! } });
    });
  }, [creds, padId]);

  if (pad && now > pad.info.expiresAt) return <Message>This pad expired.</Message>;
  if (gone) return <Message>{gone}</Message>;
  if (!pad || !creds) return <Shell />;

  const minutes = Math.max(0, Math.floor((pad.info.expiresAt - now) / 60_000));
  return (
    <Shell right={`${Math.floor(minutes / 60)}h ${minutes % 60}m left`}>
      <main className="grid flex-1 gap-3 p-3 pt-0 md:grid-cols-2">
        <Item creds={creds} info={pad.info} meta={pad.meta} uploadError={uploadError} />
        <SharePanel creds={creds} startOpen={freshPads.has(padId)} />
      </main>
    </Shell>
  );
}

function Item({ creds, info, meta, uploadError }: { creds: Creds; info: PadInfo; meta: ItemMeta; uploadError: string }) {
  const ready = info.uploaded === info.chunks;
  const isText = meta.kind === 'text';
  const isImage = meta.type.startsWith('image/');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!ready || !(isText || isImage) || meta.size > PREVIEW_MAX) return;
    let url = '';
    readItem(creds, info, meta).then(async (b) => {
      setBlob(b);
      if (isText) setText(await b.text());
      else setImageUrl((url = URL.createObjectURL(b)));
    }, (e) => setStatus(errorMessage(e)));
    return () => URL.revokeObjectURL(url);
  }, [ready]);

  async function copy() {
    try {
      if (text !== null) await navigator.clipboard.writeText(text);
      else await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(blob!) })]);
      setStatus('Copied');
    } catch {
      setStatus("Couldn't copy. Try Download.");
    }
    setTimeout(() => setStatus(''), 2000);
  }

  async function save() {
    setStatus('Decrypting…');
    try {
      download(blob ?? (await readItem(creds, info, meta)), meta.name);
      setStatus('');
    } catch (e) {
      setStatus(errorMessage(e));
    }
  }

  return (
    <section className="panel flex min-h-72 min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
        <span className="truncate font-medium">{isText ? 'Text' : meta.name}</span>
        <span className="shrink-0 text-sm text-muted tabular-nums">{formatBytes(meta.size)}</span>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
        {uploadError ? (
          <p className="text-accent">Upload failed: {uploadError}</p>
        ) : !ready ? (
          <div className="w-full max-w-xs text-center">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-ink transition-[width]" style={{ width: `${(info.uploaded / info.chunks) * 100}%` }} />
            </div>
            <p className="mt-3 text-sm text-muted">Encrypting and uploading…</p>
          </div>
        ) : text !== null ? (
          <pre className="w-full self-start font-mono text-sm break-words whitespace-pre-wrap">{text}</pre>
        ) : imageUrl ? (
          <img src={imageUrl} alt={meta.name} className="max-h-[60vh] max-w-full rounded-lg object-contain" />
        ) : (
          <p className="font-mono text-sm text-muted">{meta.type || 'file'}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
        {(text !== null || imageUrl) && (
          <button className="btn-primary" onClick={copy}>
            Copy
          </button>
        )}
        <button className={text !== null || imageUrl ? 'btn' : 'btn-primary'} onClick={save} disabled={!ready}>
          Download
        </button>
        <span aria-live="polite" className="text-sm text-muted">
          {status}
        </span>
        <EndButton creds={creds} />
      </div>
    </section>
  );
}

// Clipboard images must be PNG. Passing a promise keeps Safari's user-gesture check happy.
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const img = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject()), 'image/png'));
}

function EndButton({ creds }: { creds: Creds }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      className={`btn ml-auto ${armed ? 'border-accent text-accent' : ''}`}
      onClick={async () => {
        if (!armed) return setArmed(true);
        await endPad(creds);
        navigate('/');
      }}
    >
      {armed ? 'Delete for everyone?' : 'End pad'}
    </button>
  );
}
