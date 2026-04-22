import type { Metadata } from 'next';
import { Urbanist, Outfit } from 'next/font/google';
import './globals.css';

const urbanist = Urbanist({
  subsets: ['latin'],
  variable: '--font-urbanist',
  weight: ['400', '500', '600', '700', '800', '900'],
  display: 'swap',
});

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://www.originfacts.com'),
  title: 'Originfacts — Coming Soon',
  description: 'A sharper way to plan travel — honest reviews, cheap-flight tactics, and hand-picked itineraries. Coming soon.',
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    siteName: 'Originfacts',
    title: 'Originfacts — Coming Soon',
    description: 'A sharper way to plan travel. Coming soon.',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${urbanist.variable} ${outfit.variable}`}>
      <body className="font-sans font-light" data-testid="app-shell">
        {children}
      </body>
    </html>
  );
}
