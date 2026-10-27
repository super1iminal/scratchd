import { useEffect, useRef, useState } from 'react';
import { CODE_LENGTH, MAX_FILE_BYTES } from '@scratchd/shared';
import { formatCode, normalizeCode } from '../lib/code';
import { createPad } from '../lib/pad';
import { joinWithCode } from '../lib/pairing';
import { errorMessage, navigate } from '../lib/ui';
import { Shell } from './Shell';

// Pads created in this tab open with the share code already showing.
export const freshPads = new Set<string>();

const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

export function Home() {
  return (
    <Shell>
      <main className="grid flex-1 grid-rows-2 gap-3 p-3 pt-0 md:grid-cols-2 md:grid-rows-1">
        <Upload />
        <CodeEntry />
      </main>
    </Shell>
  );
}

function Upload() {
  const [drag, setDrag] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function share(item: File | string) {
    if (busy) return;
    if (typeof item !== 'string' && item.size > MAX_FILE_BYTES) return setError('Files can be up to 1 GB.');
    setBusy(true);
    setError('');
    try {
      const { padId } = await createPad(item);
      freshPads.add(padId);
      navigate(`/p/${padId}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  // Paste anywhere on the page (outside text fields) shares the clipboard.
  const shareRef = useRef(share);
  shareRef.current = share;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as Element).closest?.('input, textarea')) return;
      const file = e.clipboardData?.files[0];
      const pasted = e.clipboardData?.getData('text/plain');
      if (file) shareRef.current(file);
      else if (pasted?.trim()) shareRef.current(pasted);
    };
    addEventListener('paste', onPaste);
    return () => removeEventListener('paste', onPaste);
  }, []);

  if (writing) {
    return (
      <section className="panel flex min-h-0 flex-col">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type or paste text"
          aria-label="Text to share"
          className="min-h-0 flex-1 resize-none bg-transparent p-5 font-mono text-[15px] outline-none placeholder:text-muted"
        />
        <div className="flex items-center justify-between gap-3 border-t border-line p-3">
          <button className="btn" onClick={() => setWriting(false)}>
            Cancel
          </button>
          {error && <p className="text-sm text-accent">{error}</p>}
          <button className="btn-primary" disabled={!text.trim() || busy} onClick={() => share(text)}>
            {busy ? 'Encrypting…' : 'Share text'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`panel relative flex flex-col border-dashed transition-colors has-[:focus-visible]:border-accent ${drag ? 'border-accent bg-accent/5' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const file = e.dataTransfer.files[0];
        if (file) share(file);
      }}
    >
      <label className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-2 p-6 text-center">
        <input type="file" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && share(e.target.files[0])} />
        <svg viewBox="0 0 24 24" className="mb-2 size-7 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M12 16V4m0 0-5 5m5-5 5 5M4 20h16" />
        </svg>
        <span className="text-2xl font-semibold tracking-tight">
          {busy ? (
            'Encrypting…'
          ) : (
            <>
              <span className="pointer-coarse:hidden">Drag and drop a file</span>
              <span className="hidden pointer-coarse:inline">Choose a file</span>
            </>
          )}
        </span>
        <span className="text-muted pointer-coarse:hidden">
          or <span className="text-ink underline underline-offset-4">browse</span>
        </span>
        <span className="mt-4 flex items-center gap-1.5 text-sm pointer-coarse:hidden">
          <kbd className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-xs">{MOD_KEY}</kbd>
          <kbd className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-xs">V</kbd>
          <span className="text-muted">to paste text or an image</span>
        </span>
        {error && <span className="text-sm text-accent">{error}</span>}
      </label>
      <span className="absolute top-4 right-5 text-xs text-muted">1GB max</span>
      <button className="mb-4 self-center text-sm text-muted underline underline-offset-4 hover:text-ink" onClick={() => setWriting(true)}>
        Write text instead
      </button>
    </section>
  );
}

function CodeEntry() {
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function join(c: string) {
    setJoining(true);
    setFailed(false);
    setMessage('Checking code…');
    try {
      const { padId } = await joinWithCode(c);
      navigate(`/p/${padId}`);
    } catch (e) {
      setFailed(true);
      setMessage(errorMessage(e));
      setJoining(false);
    }
  }

  function change(value: string) {
    const c = normalizeCode(value);
    setCode(c);
    setMessage('');
    setFailed(false);
    if (c.length === CODE_LENGTH) join(c);
  }

  // QR codes link to /#c=CODE; the fragment never reaches the server.
  useEffect(() => {
    const m = location.hash.match(/^#c=(\w+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    change(m[1]);
  }, []);

  return (
    <section className="panel flex flex-col items-center justify-center gap-4 p-6 text-center">
      <label htmlFor="code" className="text-2xl font-semibold tracking-tight">
        Enter a code
      </label>
      <input
        id="code"
        value={formatCode(code)}
        onChange={(e) => change(e.target.value)}
        readOnly={joining} // not disabled: that would drop focus, and a typo should be fixable in place
        placeholder="XXXX-XXXX"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="w-full max-w-[13ch] rounded-xl border border-line bg-paper px-4 py-3 font-mono text-3xl tracking-[0.12em] uppercase outline-none placeholder:text-line focus:border-ink read-only:opacity-60"
      />
      <p aria-live="polite" className={`min-h-5 text-sm ${failed ? 'text-accent' : 'text-muted'}`}>
        {message || (
          <>
            <span className="pointer-coarse:hidden">From the device that has the file.</span>
            <span className="hidden pointer-coarse:inline">Or scan its QR code with your camera.</span>
          </>
        )}
      </p>
    </section>
  );
}
