import { Geist } from 'next/font/google';

/**
 * The help centre's Latin typeface: Geist, the face the help-centre design is
 * set in ("ShipBlu support landing page v02" in Claude Design). Its Arabic is
 * Rubik, the design's Arabic face, from the self-hosted 'Rubik Arabic' faces in
 * `globals.css`; the two are declared in one stack on `.kb-shell` and the
 * browser picks per glyph.
 *
 * Only the help centre's: the console and the widget keep their own stacks,
 * and the layouts that render the help centre (`layout.tsx`, `../error.tsx`)
 * are the only places this variable is applied.
 *
 * Served from our own origin via `next/font` rather than linked from Google.
 * The font is fetched at build time and fingerprinted, so a page load makes no
 * third-party request, needs no `preconnect`, and cannot be held up by
 * fonts.googleapis.com being slow from Egypt. `display: swap` means text is
 * readable from the first paint either way. Geist is a variable font, so one
 * file carries every weight the design uses (400, 500 and 600).
 *
 * The variable does not hold a single family. `next/font` also emits a
 * metric-matched `local("Arial")` face — `Geist Fallback` — and splices it into
 * the variable right behind its own family, so `--font-geist` is
 * `"Geist", "Geist Fallback"`. That face declares no `unicode-range`, which
 * makes it a candidate for *every* codepoint, Arabic included. Ordering around
 * that is `.kb-shell`'s job in `globals.css`; see the comment there before
 * changing the stack.
 *
 * `adjustFontFallback: false` is the documented way to suppress that face and
 * would be the tidier fix. It does not work: Turbopack's `next/font`
 * implementation — the bundler both `next dev` and `next build` use here —
 * accepts the option and ignores it. Verified on 16.3.1 with the Lato this
 * replaced, by renaming the variable in this file and watching the rename land
 * in the served CSS while the fallback stayed. So the ordering fix is not a
 * matter of taste; it is the only one available.
 */
export const geist = Geist({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist',
});
