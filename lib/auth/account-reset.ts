import type { Locale } from '@/lib/kb/locale';
import { requestPasswordReset } from '@/lib/portal/accounts';
import { requestAgentPasswordReset } from './password-reset';

/**
 * "I forgot my password", for whoever typed the address.
 *
 * Both sign-in forms take both populations (`authenticate()` says why), so
 * both forgotten-password forms have to as well: somebody who signs in on the
 * help centre with their console password will ask for it back there. The
 * order is `authenticate()`'s — an agent first, and an agent never falls
 * through — because the password a link changes must be the one the form
 * beside it checks. Asked the other way, a staff address that is also a
 * contact got a link that changed a password nothing signs them in with.
 *
 * Answers nothing, on purpose: the caller says the same sentence whoever the
 * address belongs to, and nobody's.
 */
export async function requestAccountReset(email: string, locale: Locale): Promise<void> {
  if (await requestAgentPasswordReset(email)) return;
  await requestPasswordReset(email, locale);
}
