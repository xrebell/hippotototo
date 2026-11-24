import type { Metadata, Viewport } from 'next';

import HippoRunClient from '@/components/hippo-run/hippo-run-client';

export const metadata: Metadata = {
  title: 'Hippo Tototo — Play',
  description:
    'Hippo Tototo: Stomp the Beat. A one-button rhythm runner: jump, belly-SLAM and BOING a heavy little hippo across a festival savanna, bouncing drum to drum to play the tune.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0B0B1E',
};

export default function PlayPage() {
  return <HippoRunClient />;
}
