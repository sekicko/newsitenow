import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MarketPilot — Explore the market. Practice with clarity.',
  description:
    'Practice market decisions with live market prices, tick data, and transparent simulated contracts.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
