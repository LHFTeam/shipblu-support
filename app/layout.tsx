import type { Metadata } from 'next';
import { tajawal } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'ShipBlu Support',
  description: 'ShipBlu customer support console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Tajawal's variable on the root so its Arabic-subset face is on every
    // page; `--font-console` names the family directly, never the variable,
    // whose metric fallback is Arial with no unicode-range (see fonts.ts).
    <html lang="en" className={tajawal.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
