'use client';

import { PrinterIcon } from '@/components/icons';
import { buttonClass } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';

/**
 * Print this article.
 *
 * Merchants print the claims and delivery procedures and hand them to whoever
 * is packing that day, so the affordance is worth the one client component —
 * and the print stylesheet in `globals.css` is what makes the result a document
 * rather than a screenshot of a website.
 *
 * A ghost button at the top of the panel, not beside the feedback question at
 * the foot as the design system's kit draws it: that row swaps itself for a
 * thank-you line, and a merchant should not have to scroll a long procedure to
 * print it.
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
      className={`kb-noprint ${buttonClass({ variant: 'ghost' })}`}
    >
      <PrinterIcon size={17} />
      {t(locale, 'print')}
    </button>
  );
}
