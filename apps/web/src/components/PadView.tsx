import { useEffect, useMemo, useRef, useState } from 'react';
import type { PadEvent, PadInfo } from '@scratchd/shared';
import type { ItemMeta } from '../lib/crypto';
import { api } from '../lib/api';
import { download, forgetCreds, loadCreds, loadPad, readItem, uploads, type Creds } from '../lib/pad';
import { previewKind } from '../lib/preview';
import { errorMessage, formatBytes, useNow } from '../lib/ui';
import { freshPads } from './Home';
import { SharePanel } from './SharePanel';
import { Message, Shell } from './Shell';

export function PadView({ padId }: { padId: string }) {
  const creds = useMemo(() => loadCreds(padId), [padId]);
  const [pad, setPad] = useState<{ info: PadInfo; meta: ItemMeta } | null>(null);
  const [gone, setGone] = useState(creds ? '' : "This pad isn't open on this device.");
  const [uploadError, setUploadError] = useState('');
  const now = useNow(30_000);

  useEffect(() => {
    if (!creds) return;
    loadPad(creds).then(setPad, () => setGone('This pad was deleted or has expired.'));
    uploads.get(padId)?.then(
      () => setPad((p) => p && { ...p, info: { ...p.info, uploaded: p.info.chunks } }), // don't wait for the next poll
      (e) => setUploadError(errorMessage(e)),
    );
    return api.watchPad(padId, creds.token, (e: PadEvent) => {
      if (e.type === 'ended') {
        forgetCreds(padId);
        setGone('This pad was deleted.');
      } else setPad((p) => p && { ...p, info: { ...p.info, uploaded: e.uploaded! } });
    });
  }, [creds, padId]);

  const minutes = pad ? Math.max(0, Math.floor((pad.info.expiresAt - now) / 60_000)) : 0;
  const left = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  const title = pad && !gone && now <= pad.info.expiresAt ? `${left} · scratchd` : 'scratchd';
  useEffect(() => {
    document.title = title;
    return () => void (document.title = 'scratchd');
  }, [title]);

  if (pad && now > pad.info.expiresAt) return <Message>This pad expired.</Message>;
  if (gone) return <Message>{gone}</Message>;
  if (!pad || !creds) return <Shell />;

  return (
    <Shell>
      <main className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-3 p-3 pt-0 md:grid-cols-2 md:grid-rows-[minmax(0,1fr)]">
        <Item creds={creds} info={pad.info} meta={pad.meta} uploadError={uploadError} left={`${left} left`} />
        <SharePanel creds={creds} startOpen={freshPads.has(padId)} />
      </main>
    </Shell>
  );
}

function Item({ creds, info, meta, uploadError, left }: { creds: Creds; info: PadInfo; meta: ItemMeta; uploadError: string; left: string }) {
  const ready = info.uploaded === info.chunks;
  const kind = previewKind(meta);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState('');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!ready || !kind) return;
    let objectUrl = '';
    readItem(creds, info, meta).then(async (b) => {
      setBlob(b);
      if (kind === 'text' || kind === 'markdown') {
        const t = await b.text();
        setText(t);
        if (kind === 'markdown') {
          const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]);
          setHtml(DOMPurify.sanitize(await marked.parse(t)));
        }
      }
      else if (kind !== 'pdf') setUrl((objectUrl = URL.createObjectURL(b)));
    }, (e) => setStatus(errorMessage(e)));
    return () => URL.revokeObjectURL(objectUrl);
  }, [ready]);

  const canCopy = text !== null || (kind === 'image' && !!url);

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
    <section className="panel flex min-h-0 min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
        <span className="truncate font-medium">{meta.kind === 'text' ? 'Text' : meta.name}</span>
        <span className="shrink-0 text-sm text-muted tabular-nums">{formatBytes(meta.size)}</span>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5 [scrollbar-width:thin]">
        {uploadError ? (
          <p className="text-accent">Upload failed: {uploadError}</p>
        ) : !ready ? (
          <div className="w-full max-w-xs text-center">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-ink transition-[width]" style={{ width: `${(info.uploaded / info.chunks) * 100}%` }} />
            </div>
            <p className="mt-3 text-sm text-muted">Encrypting and uploading…</p>
          </div>
        ) : html ? (
          <div className="prose prose-neutral dark:prose-invert prose-code:before:content-none prose-code:after:content-none w-full max-w-none self-start" dangerouslySetInnerHTML={{ __html: html }} />
        ) : text !== null ? (
          <pre className="w-full self-start font-mono text-base break-words whitespace-pre-wrap">{text}</pre>
        ) : url && kind === 'image' ? (
          <img src={url} alt={meta.name} className="max-h-[60vh] max-w-full rounded-lg object-contain" />
        ) : blob && kind === 'pdf' ? (
          <PdfPages blob={blob} onError={() => setStatus("Couldn't preview this PDF. Try Download.")} />
        ) : url && kind === 'video' ? (
          <video src={url} controls className="max-h-[60vh] max-w-full rounded-lg" />
        ) : url && kind === 'audio' ? (
          <audio src={url} controls className="w-full" />
        ) : (
          <p className="font-mono text-sm text-muted">{meta.type || 'file'}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
        {canCopy && (
          <button className="btn-primary" onClick={copy}>
            Copy
          </button>
        )}
        <button className={canCopy ? 'btn' : 'btn-primary'} onClick={save} disabled={!ready}>
          Download
        </button>
        <span aria-live="polite" className="text-sm text-muted">
          {status}
        </span>
        <span className="ml-auto pr-2 text-sm text-muted tabular-nums">{left}</span>
      </div>
    </section>
  );
}

// pdf.js (~1.5 MB with its worker) loads only when a PDF is previewed.
// shortcut: renders every page up front; render on scroll if long PDFs feel slow.
function PdfPages({ blob, onError }: { blob: Blob; onError: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current!;
    let cancelled = false;
    let destroy = () => {};
    (async () => {
      const [pdfjs, { default: workerSrc }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
      destroy = () => void task.destroy();
      const pdf = await task.promise;
      for (let i = 1; i <= pdf.numPages && !cancelled; i++) {
        const page = await pdf.getPage(i);
        const scale = box.clientWidth / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        const dpr = devicePixelRatio;
        const wrap = document.createElement('div');
        wrap.className = 'relative overflow-hidden rounded-md bg-white shadow-sm';
        wrap.style.setProperty('--total-scale-factor', String(scale));
        wrap.setAttribute('aria-label', `Page ${i} of ${pdf.numPages}`);
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.className = 'block w-full';
        const text = document.createElement('div');
        text.className = 'textLayer';
        wrap.append(canvas, text);
        box.append(wrap);
        await page.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
        await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
      }
    })().catch(() => !cancelled && onError());
    return () => {
      cancelled = true;
      destroy();
      box.replaceChildren();
    };
  }, [blob]);
  return <div ref={ref} role="document" className="flex w-full flex-col gap-3 self-start" />;
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
