'use client';

import { PrinterIcon } from '@/components/icons';
import { t, type Locale } from '@/lib/kb/locale';

/**
 * Print this article.
 *
 * Merchants print the claims and delivery procedures and hand them to whoever
 * is packing that day, so the affordance is worth the one client component —
 * and the print stylesheet in `globals.css` is what makes the result a document
 * rather than a screenshot of a website.
 *
 * The last fact in the meta row under the title, drawn as one of them, rather
 * than a button of its own: the design has no place for it, and the body now
 * sits on the canvas with no card whose corner it used to occupy. It is still
 * at the top, not beside the feedback question at the foot as the design
 * system's kit draws it — that card swaps itself for a thank-you line, and a
 * merchant should not have to scroll a long procedure to print it. Quiet, since
 * printing is what a few readers do, and underlined on hover so it says it can
 * be pressed. 24px tall at the least, the smallest target a thumb is promised.
 *
 * A `<button>` rather than the `href="javascript:print()"` the live portal uses:
 * that is not a link, it does not survive a content-security policy, and it
 * offers a keyboard user a destination that does not exist.
 */
export function PrintButton({ locale }: { locale: Locale }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="kb-noprint inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-(--color-text-secondary) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
    >
      <PrinterIcon size={14} className="shrink-0 text-(--color-text-tertiary)" />
      {t(locale, 'print')}
    </button>
  );
}
