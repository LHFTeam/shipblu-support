import type { Logger } from '@/lib/log';
import { credentialsForPhoneNumberId, type WhatsAppCredentials } from '@/lib/whatsapp/accounts';
import { WhatsAppApiError } from '@/lib/whatsapp/client';
import { recordCredentialRefusal } from '@/lib/whatsapp/credentials';
import { ACCESS_TOKEN_CODE } from '@/lib/whatsapp/errors';

/**
 * A stored credential Meta refused (190) on a call a handler made with it,
 * recorded on the credential: the console's "refused by Meta" badge and the
 * `refused` event read it, and they are what send an admin to Reconnect. The
 * hourly template sync records the same, but an agent's reply bouncing or a
 * customer's photo failing to download is usually the first anybody knows,
 * and waiting up to an hour for the badge leaves the console's own record of
 * the credential saying all is well. `recordCredentialRefusal` writes the
 * event only on a transition, so every failing call and its retries add one
 * event between them. Anything other than a 190 on a stored credential is
 * left alone: a variable or the shared token has no row to record on.
 *
 * Only while the credential that refused is still the one stored. A call is
 * resolved, then answered a moment later, and a Reconnect committing in
 * between replaces the credential: the old token's refusal recorded then would
 * badge the fresh one "refused" until the next hourly sync verified it — the
 * very thing `storeBusinessToken` clears the refusal to prevent. So the
 * number's credential is resolved again and compared by token, which needs no
 * clock: the worker's and the web service's need not agree, so an instant
 * passed to `recordCredentialRefusal` could not settle it. A Reconnect landing
 * in the milliseconds between that and the record is the race the hourly sync
 * accepts too.
 *
 * Meta's sentence, not the explained one — the credential's record is what
 * Meta said about it, as the sync writes it. And never allowed to stop the
 * caller rethrowing: 190 is retryable on purpose (`lib/whatsapp/client.ts`),
 * so the reply still delivers, and the file still downloads, on the attempt
 * after the reconnect.
 */
export async function recordRefusalIfStored(
  log: Logger,
  subject: string,
  phoneNumberId: string | null,
  used: WhatsAppCredentials,
  error: unknown,
): Promise<void> {
  if (!(error instanceof WhatsAppApiError) || error.code !== ACCESS_TOKEN_CODE) return;
  if (used.source !== 'stored' || !used.accountId) return;
  try {
    const current = await credentialsForPhoneNumberId(phoneNumberId);
    if (
      current.source !== 'stored' ||
      current.accountId !== used.accountId ||
      current.token !== used.token
    ) {
      log.info(
        `${subject}: the credential changed since this call, so its refusal is not recorded`,
      );
      return;
    }
    await recordCredentialRefusal(used.accountId, error.message);
  } catch (recordError) {
    log.error(`${subject}: recording the refusal on the stored credential failed`, recordError);
  }
}
