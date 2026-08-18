import { redirect } from 'next/navigation';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';

/**
 * The help centre root. Reached as `/` on the help-centre hostname, which the
 * proxy rewrites here.
 *
 * A redirect rather than rendering the default locale in place, so every page
 * has exactly one URL — serving the same content at both `/` and `/en` splits
 * its search ranking between them.
 */
export default function HelpRoot() {
  redirect(`/${DEFAULT_LOCALE}`);
}
