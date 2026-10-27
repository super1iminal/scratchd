import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { formatCode } from '../lib/code';
import { api } from '../lib/api';
import { endPad, type Creds } from '../lib/pad';
import { startSharing } from '../lib/pairing';
import { errorMessage, navigate, useNow } from '../lib/ui';

type Share = Awaited<ReturnType<typeof startSharing>>;

// Unused codes refresh this many times, then the panel asks before making more.
const MAX_IDLE_REFRESHES = 5;

// The live code survives a reload of this tab. It sits next to the pad key, which already
// grants more than the code does. Its presence also marks a tab that shares this pad.
const shareKey = (padId: string) => `share:${padId}`;
const savedShare = (padId: string): Share | null => {
  const s: Share | null = JSON.parse(sessionStorage.getItem(shareKey(padId)) ?? 'null');
  return s && s.expiresAt > Date.now() ? s : null;
};

// The device that made the pad shows a code straight away; a device that joined with one is asked first.
export function SharePanel({ creds, startOpen }: { creds: Creds; startOpen: boolean }) {
  const [open, setOpen] = useState(() => startOpen || sessionStorage.getItem(shareKey(creds.padId)) !== null);
  const [round, setRound] = useState(0); // bump for a fresh code
  const [share, setShare] = useState<Share | null>(null);
  const [making, setMaking] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [error, setError] = useState('');
  const idleRefreshes = useRef(0);
  const now = useNow(1000);

  useEffect(() => {
    if (!open) return;
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const next = () => setRound((r) => r + 1);
    // The old code stays on screen, dimmed, so the layout doesn't jump while Argon2 runs.
    setMaking(true);
    setError('');
    const saved = round === 0 ? savedShare(creds.padId) : null;
    (saved ? Promise.resolve(saved) : startSharing(creds)).then(
      (s) => {
        if (cancelled) return;
        sessionStorage.setItem(shareKey(creds.padId), JSON.stringify(s));
        setShare(s);
        setMaking(false);
        // A code works once: swap in a fresh one when it's used, burned or expires.
        stop = api.watchChannel(s.channelId, () => ((idleRefreshes.current = 0), next()));
        timer = setTimeout(() => {
          if (++idleRefreshes.current <= MAX_IDLE_REFRESHES) return next();
          idleRefreshes.current = 0;
          sessionStorage.removeItem(shareKey(creds.padId));
          setShare(null);
          setOpen(false);
        }, s.expiresAt - Date.now());
      },
      (e) => setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
      stop?.();
      clearTimeout(timer);
    };
  }, [open, round, creds]);

  const secondsLeft = share ? Math.max(0, Math.ceil((share.expiresAt - now) / 1000)) : 0;

  return (
    <section className="panel flex min-w-0 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
        {!open ? (
          <>
            <p className="text-muted">Need this on another device?</p>
            <button className="btn" onClick={() => setOpen(true)}>
              Share with a code
            </button>
          </>
        ) : !share ? (
          <p className="text-muted">{error || 'Making a code…'}</p>
        ) : (
          <>
            <p className="text-muted">On the other device, enter</p>
            <div className={`flex flex-col items-center gap-5 transition-opacity ${making ? 'opacity-30' : ''}`} aria-busy={making}>
              <output className="font-mono text-4xl font-medium tracking-[0.12em] sm:text-5xl">{formatCode(share.code)}</output>
              {/* On a phone the QR would crowd out the item, so it waits for a tap. */}
              <div className={showQr ? '' : 'hidden md:block'}>
                <QR value={`${location.origin}/#c=${share.code}`} />
              </div>
            </div>
            {!showQr && (
              <button className="text-sm text-muted underline underline-offset-4 hover:text-ink md:hidden" onClick={() => setShowQr(true)}>
                Show QR code
              </button>
            )}
            <p className="text-sm text-muted tabular-nums">
              {making
                ? error || 'Making a new code…'
                : `Refreshes in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`}
            </p>
          </>
        )}
      </div>
      <div className="flex justify-between border-t border-line p-3">
        {/* The current pad stays open in this tab's history; Back returns to it. */}
        <button className="btn" onClick={() => navigate('/')}>
          New pad
        </button>
        <DeleteButton creds={creds} />
      </div>
    </section>
  );
}

function QR({ value }: { value: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(value, { type: 'svg', margin: 2 }).then(setSvg);
  }, [value]);
  // Always dark-on-white: phone cameras don't reliably read inverted codes.
  return <div role="img" aria-label="QR code with the same code" className="size-36 rounded-lg bg-white [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function DeleteButton({ creds }: { creds: Creds }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      className={`btn ${armed ? 'border-accent text-accent' : ''}`}
      onClick={async () => {
        if (!armed) return setArmed(true);
        await endPad(creds);
        navigate('/');
      }}
    >
      {armed ? 'Confirm' : 'Delete pad'}
    </button>
  );
}
