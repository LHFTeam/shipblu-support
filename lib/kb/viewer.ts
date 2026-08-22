import { getSessionCustomer } from '@/lib/auth/customer-session';
import { ANONYMOUS, type KbViewer } from './visibility';

/**
 * The help centre's reader, resolved from the portal session cookie.
 *
 * One helper rather than each page doing it, so "signed in" means the same
 * thing on the home page, a folder, an article and a search — and so the pages
 * that must *not* do this stand out by not calling it. Today that is the
 * sitemap and the embedded widget, both of which pass `ANONYMOUS` and say why.
 *
 * Safe on every page here because all of them are `force-dynamic`. A cached
 * page that varied by viewer would be the real hazard in this feature: one
 * signed-in customer's render served from the cache to an anonymous crawler
 * publishes exactly the articles this is supposed to gate. If any help centre
 * page is ever made static or given a `revalidate`, it has to stop calling this.
 */
export async function kbViewer(): Promise<KbViewer> {
  const customer = await getSessionCustomer();
  if (!customer) return ANONYMOUS;

  return {
    kind: 'customer',
    contactId: customer.contactId,
    companyId: customer.companyId,
  };
}
