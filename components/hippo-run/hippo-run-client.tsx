'use client';

/**
 * React mount for the Hippo Tototo engine (spec §14.7). The ONLY engine-folder file that imports
 * React / Next. StrictMode-safe: the effect's cleanup destroys the game, and createGame() can be
 * called again on the same canvas (mount -> destroy -> mount).
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { createGame } from './index';
import type { GameMode } from './types';

/**
 * The site header (rendered by app/layout.tsx, which the game must not edit) sits underneath the
 * fullscreen game layer. Make it inert + hidden from assistive tech while /play is mounted so its
 * invisible links never take keyboard focus or screen-reader attention. Returns the restore
 * function (puts back whatever values were there before, so StrictMode mount -> cleanup -> mount
 * and client navigation away from /play leave the header exactly as it was).
 */
function hideSiteHeader(gameRoot: HTMLElement | null): () => void {
  const header = Array.from(document.querySelectorAll<HTMLElement>('body > header, header')).find((h) => !gameRoot || !gameRoot.contains(h));
  if (!header) return () => {};
  const prevInert = header.getAttribute('inert');
  const prevAriaHidden = header.getAttribute('aria-hidden');
  header.setAttribute('inert', '');
  header.setAttribute('aria-hidden', 'true');
  return () => {
    if (prevInert === null) header.removeAttribute('inert');
    else header.setAttribute('inert', prevInert);
    if (prevAriaHidden === null) header.removeAttribute('aria-hidden');
    else header.setAttribute('aria-hidden', prevAriaHidden);
  };
}

export default function HippoRunClient() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<GameMode>('title');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const root = document.documentElement;
    const body = document.body;
    const prevRootOverflow = root.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevOverscroll = root.style.overscrollBehavior;
    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';
    const restoreHeader = hideSiteHeader(rootRef.current);

    const handle = createGame(canvas, { onStateChange: setMode });
    return () => {
      handle.destroy();
      restoreHeader();
      root.style.overflow = prevRootOverflow;
      body.style.overflow = prevBodyOverflow;
      root.style.overscrollBehavior = prevOverscroll;
    };
  }, []);

  const showChrome = mode === 'title' || mode === 'paused' || mode === 'gameover';

  return (
    <div ref={rootRef} className="fixed inset-0 z-50 bg-[#0B0B1E]" style={{ height: '100dvh' }}>
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none select-none"
        style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
        aria-label="Hippo Tototo: Stomp the Beat — one-button rhythm runner. Press Space or tap to play."
      />
      {showChrome && (
        <Link
          href="/"
          prefetch={false}
          className="absolute top-[max(0.75rem,env(safe-area-inset-top))] left-[max(0.75rem,env(safe-area-inset-left))] rounded-full bg-gray-950/60 px-3 py-1.5 text-sm font-medium text-indigo-100 backdrop-blur-sm transition hover:bg-gray-900/80 hover:text-white"
        >
          <span aria-hidden="true">&larr;</span> Back to site
        </Link>
      )}
      {mode === 'title' && (
        <footer className="pointer-events-none absolute inset-x-0 bottom-[max(0.5rem,env(safe-area-inset-bottom))] text-center text-xs text-indigo-200/60">
          Hippo Tototo · a playable demo ·{' '}
          <a href="/play.html" className="pointer-events-auto underline underline-offset-2 hover:text-indigo-100">
            Standalone version
          </a>
        </footer>
      )}
    </div>
  );
}
