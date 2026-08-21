import { Lato, Tajawal } from 'next/font/google';

/**
 * The help centre's two typefaces.
 *
 * Lato and Tajawal, the same pairing the live Freshdesk portal loads, so the
 * new help centre reads as the same site to a returning customer. Lato covers
 * Latin, Tajawal covers Arabic; the two are declared in one stack and the
 * browser picks per glyph, which is why no `:lang()` rule is needed.
 *
 * Served from our own origin via `next/font` rather than linked from Google.
 * The fonts are fetched at build time and fingerprinted, so a page load makes
 * no third-party request, needs no `preconnect`, and cannot be held up by
 * fonts.googleapis.com being slow from Egypt. `display: swap` means text is
 * readable from the first paint either way.
 */

export const lato = Lato({
  subsets: ['latin'],
  weight: ['400', '700', '900'],
  display: 'swap',
  variable: '--font-lato',
});

export const tajawal = Tajawal({
  subsets: ['arabic'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-tajawal',
});
