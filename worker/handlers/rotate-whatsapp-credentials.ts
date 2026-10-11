import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { resealStoredCredentials } from '@/lib/whatsapp/credentials';
import { logger } from '@/lib/log';

const log = logger('rotate_whatsapp_credentials');

/**
 * Moves every stored WhatsApp credential onto the current key.
 *
 *   npm run job -- rotate_whatsapp_credentials dryRun=true
 *   npm run job -- rotate_whatsapp_credentials
 *
 * The middle step of a rotation: `WHATSAPP_CREDENTIAL_KEY_PREVIOUS` set to the
 * key being retired and `WHATSAPP_CREDENTIAL_KEY` to the new one, on every
 * service (they all read the group); this; then the previous variable unset.
 * The dry run opens every envelope it would move and writes nothing, so run it
 * first — it is what proves the previous key is the one the rows were sealed
 * under, before anything depends on it.
 *
 * Hand-run and on no cron. Fails, so the run goes red, when any row could not
 * be moved: that row is sealed under a key neither variable holds, it will not
 * open after the previous key is unset, and the number behind it sends nothing
 * until it is reconnected — which is the one thing a rotation must not do
 * quietly.
 *
 * With no key configured and nothing stored it skips, which is every
 * environment before the first number is connected through Meta.
 */
export async function rotateWhatsAppCredentials(job: ClaimedJob): Promise<void> {
  const { dryRun = false } = parseJobPayload(job, 'rotate_whatsapp_credentials');
  const summary = await resealStoredCredentials({ dryRun });

  if (!summary) {
    log.info('WHATSAPP_CREDENTIAL_KEY is not set and no credential is stored — skipping');
    return;
  }

  log.info(
    dryRun
      ? `dry run: ${summary.resealed} of ${summary.examined} credential(s) on an older key open with this keyring; nothing written`
      : `resealed ${summary.resealed} of ${summary.examined} credential(s) on an older key`,
    {
      dryRun,
      examined: summary.examined,
      resealed: summary.resealed,
      failed: summary.failed.length,
    },
  );

  if (summary.failed.length > 0) {
    throw new Error(
      `${summary.failed.length} credential(s) could not be opened with this keyring and were ` +
        `left as they are — ${summary.failed
          .map((failure) => `account ${failure.accountId}: ${failure.reason}`)
          .join('; ')}`,
    );
  }
}
