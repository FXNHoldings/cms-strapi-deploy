import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'NXT Commerce Sourcing',
  description: 'Internal sourcing platform for NXT.Bargains Commerce products',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
