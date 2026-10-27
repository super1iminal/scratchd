import type { ReactNode } from 'react';
import { navigate } from '../lib/ui';

export function Shell({ right, children }: { right?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between px-5">
        <a
          href="/"
          onClick={(e) => (e.preventDefault(), navigate('/'))}
          className="font-mono text-[15px] font-semibold tracking-tight"
        >
          scratchd
        </a>
        <div className="text-sm text-muted">{right ?? 'end-to-end encrypted · gone in 24h'}</div>
      </header>
      {children}
    </div>
  );
}

export function Message({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg">{children}</p>
        <button className="btn" onClick={() => navigate('/')}>
          Back to start
        </button>
      </main>
    </Shell>
  );
}
