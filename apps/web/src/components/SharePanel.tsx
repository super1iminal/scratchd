import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatCode } from '../lib/code';
import type { Creds } from '../lib/pad';
import { startSharing } from '../lib/pairing';
import { errorMessage, useNow } from '../lib/ui';

export function SharePanel({ creds, startOpen }: { creds: Creds; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [round, setRound] = useState(0); // bump for a fresh code
  const [share, setShare] = useState<{ code: string; expiresAt: number } | null>(null);
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState('');
  const now = useNow(1000);

  useEffect(() => {
    if (!open) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    setShare(null);
    setSent(false);
    startSharing(creds, (event) => {
      if (event === 'paired') setSent(true);
      else if (event === 'wrong') setNote('Someone entered a wrong code.');
      else {
        setNote('Too many wrong attempts, so here is a new code.');
        setRound((r) => r + 1);
      }
    }).then(
      (s) => (cancelled ? s.stop() : ((stop = s.stop), setShare(s))),
      (e) => setNote(errorMessage(e)),
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [open, round, creds]);

  const again = () => (setNote(''), setRound((r) => r + 1));
  const secondsLeft = share ? Math.max(0, Math.ceil((share.expiresAt - now) / 1000)) : 0;

  return (
    <section className="panel flex flex-col items-center justify-center gap-5 p-6 text-center">
      {!open ? (
        <>
          <p className="text-muted">Need this on another device?</p>
          <button className="btn" onClick={() => setOpen(true)}>
            Share with a code
          </button>
        </>
      ) : sent ? (
        <>
          <p className="text-2xl font-semibold tracking-tight">Sent</p>
          <p className="text-muted">The other device has it now.</p>
          <button className="btn" onClick={again}>
            Share with another device
          </button>
        </>
      ) : !share ? (
        <p className="text-muted">{note || 'Making a code…'}</p>
      ) : secondsLeft === 0 ? (
        <>
          <p className="text-muted">That code expired.</p>
          <button className="btn" onClick={again}>
            New code
          </button>
        </>
      ) : (
        <>
          <p className="text-muted">
            On the other device, open <span className="text-ink">{location.host}</span> and enter
          </p>
          <output className="font-mono text-4xl font-medium tracking-[0.12em] sm:text-5xl">{formatCode(share.code)}</output>
          <QR value={`${location.origin}/#c=${share.code}`} />
          <p aria-live="polite" className="text-sm text-muted">
            {note || 'Keep this page open until it connects.'}
            <br />
            <span className="tabular-nums">
              Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </span>
          </p>
        </>
      )}
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
