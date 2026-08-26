import { Lato, Tajawal } from 'next/font/google';

/**
 * The help centre's two typefaces.
 *
 * Lato and Tajawal, the same pairing the live Freshdesk portal loads, so the
 * new help centre reads as the same site to a returning customer. Lato covers
 * Latin, Tajawal covers Arabic; the two are declared in one stack and the
 * browser picks per glyph.
 *
 * Served from our own origin via `next/font` rather than linked from Google.
 * The fonts are fetched at build time and fingerprinted, so a page load makes
 * no third-party request, needs no `preconnect`, and cannot be held up by
 * fonts.googleapis.com being slow from Egypt. `display: swap` means text is
 * readable from the first paint either way.
 *
 * Neither variable holds a single family. `next/font` also emits a
 * metric-matched `local("Arial")` face per font — `Lato Fallback`,
 * `Tajawal Fallback` — and splices it into the variable right behind its own
 * family, so `--font-lato` is `"Lato", "Lato Fallback"`. Those faces declare no
 * `unicode-range`, which makes each of them a candidate for *every* codepoint,
 * Arabic included. Ordering around that is `.kb-shell`'s job in `globals.css`;
 * see the comment there before changing either stack.
 *
 * `adjustFontFallback: false` is the documented way to suppress those faces and
 * would be the tidier fix. It does not work: Turbopack's `next/font`
 * implementation — the bundler both `next dev` and `next build` use here —
 * accepts the option and ignores it, and the variable still comes out as
 * `"Lato", "Lato Fallback"`. Verified on 16.3.1 by renaming the variable in
 * this file and watching the rename land in the served CSS while the fallback
 * stayed. So the ordering fix is not a matter of taste; it is the only one
 * available.
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
