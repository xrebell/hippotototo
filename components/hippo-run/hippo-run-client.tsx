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

export default function HippoRunClient() {
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

    const handle = createGame(canvas, { onStateChange: setMode });
    return () => {
      handle.destroy();
      root.style.overflow = prevRootOverflow;
      body.style.overflow = prevBodyOverflow;
      root.style.overscrollBehavior = prevOverscroll;
    };
  }, []);

  const showChrome = mode === 'title' || mode === 'paused' || mode === 'gameover';

  return (
    <div className="fixed inset-0 z-50 bg-[#0B0B1E]" style={{ height: '100dvh' }}>
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
