import type { Metadata } from 'next';
import { Fraunces, Geist } from 'next/font/google';
import './globals.css';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  weight: ['400', '500', '600', '700', '800', '900'],
  style: ['normal', 'italic'],
  display: 'swap',
});

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://www.fxnstudio.com'),
  title: {
    default: 'FXN Studio — Travel stories, cheap flights, smart stays',
    template: '%s · FXN Studio',
  },
  description:
    'Hand-picked travel guides, cheap flight hacks, hotel reviews and destination deep-dives from writers who actually go places.',
  openGraph: {
    type: 'website',
    siteName: 'FXN Studio',
    locale: 'en_US',
  },
  twitter: { card: 'summary_large_image' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${geist.variable}`}>
      <body className="min-h-screen flex flex-col font-sans grain" data-testid="app-shell">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
