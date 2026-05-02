import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['300', '400', '500', '600', '700', '800', '900'],
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://www.fxnstudio.com'),
  title: {
    default: 'Originfacts — Travel stories, cheap flights, smart stays',
    template: '%s · Originfacts',
  },
  description:
    'Hand-picked travel guides, cheap flight hacks, hotel reviews and destination deep-dives from writers who actually go places.',
  openGraph: { type: 'website', siteName: 'Originfacts', locale: 'en_US' },
  twitter: { card: 'summary_large_image' },
  alternates: {
    types: {
      'application/rss+xml': [{ url: '/feed.xml', title: 'Originfacts RSS' }],
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen flex flex-col font-sans font-normal grain" data-testid="app-shell">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}