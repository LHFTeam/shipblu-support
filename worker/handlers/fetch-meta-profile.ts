import {
  describeProfileRefresh,
  refreshChannelProfile,
  type ProfileRefreshResult,
} from '@/lib/meta/profile-refresh';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';

/**
 * Puts a name and a face on a Facebook or Instagram customer.
 *
 * Messenger and Instagram webhooks carry a scoped user id and nothing else —
 * no name, no handle. WhatsApp does not have this problem because its payload
 * includes the profile name, which is why 10,198 of 10,211 WhatsApp contacts are
 * named and every single Messenger and Instagram contact was not. The User
 * Profile API is the only way to close that gap, and reading it needs Meta's
 * **Business Asset User Profile Access** feature.
 *
 * A job rather than a call inside the ingest, for three reasons that all point
 * the same way: a Graph round trip inside webhook processing makes filing a
 * ticket depend on Graph being up, it would fire once per *message* instead of
 * once per person, and a profile that cannot be read must never be able to stop
 * a customer's message from becoming a ticket. Nothing here is on the path of
 * anything the customer sees.
 *
 * The work itself is `refreshChannelProfile`, shared with the console's manual
 * retry button. What is left here is the *reaction* a queue can have and an
 * agent watching a page cannot: rethrowing so the job is tried again.
 */

export async function fetchMetaProfile(job: ClaimedJob): Promise<void> {
  const { contactId, platform, userId, force } = parseJobPayload(job, 'fetch_meta_profile');
  const result = await refreshChannelProfile({
    contactId,
    platform,
    userId,
    force: force === true,
  });

  report(platform, userId, result);

  // Worth another attempt, and a queue is the thing that can make one.
  if (result.kind === 'transient') throw result.error;

  if (result.kind === 'applied' && result.picture === 'retry') {
    // Thrown after the write, so the name is already durable and the retry is
    // only about the picture. Exhausting the attempts leaves a dead row that
    // says so, which is better than a contact silently left faceless.
    throw new Error(
      `[fetch_meta_profile] ${platform} ${userId}: name saved, but the profile picture ` +
        `could not be fetched — retrying`,
    );
  }
}

/**
 * One log line per outcome, and a second one for the refusal that is not about
 * this customer at all.
 *
 * An unapproved app fails for *everybody* and looks exactly like a run of
 * private profiles, so the case that needs a human has to say so out loud. That
 * sentence was missing when the Human Agent feature turned out never to have
 * been approved (`docs/PROJECT-STATE.md` §5.2), and its absence cost eight
 * failed sends and a guess.
 */
function report(platform: string, userId: string, result: ProfileRefreshResult): void {
  const prefix = `[fetch_meta_profile] ${platform} ${userId}`;

  switch (result.kind) {
    case 'gone':
      console.log(`${prefix} no longer resolves to a contact`);
      return;
    case 'skipped':
      console.log(`${prefix} already looked up, skipping`);
      return;
    case 'unconfigured':
      console.warn(`${prefix}: ${platform} is not configured (${result.detail}), skipping`);
      return;
    case 'refused':
      console.error(`${prefix} refused: ${result.reason}`);
      if (result.permission) {
        console.error(
          `[fetch_meta_profile] this is the refusal that means the Meta app may not hold ` +
            `Business Asset User Profile Access — check App Review before treating it as a ` +
            `property of this one customer`,
        );
      }
      return;
    case 'transient':
      console.warn(`${prefix} could not be read this time: ${result.error.message}`);
      return;
    case 'applied':
      console.log(
        `${prefix} → ${describeProfileRefresh(result)}` +
          `${result.locale ? ` locale ${result.locale}.` : ''}` +
          // Whether one arrived, never which. Gender is special-category
          // personal data, nothing in this system branches on it, and a
          // backfill writes one of these lines per identified customer into
          // Render's log retention — the operational signal is that the field
          // came back, not its value.
          `${result.gender ? ' Gender recorded.' : ''}`,
      );

      /*
        The second sentence this function exists for, and the same argument as
        the refusal above: it is not about this customer.

        `extendedFieldsRefused` means Graph rejected the request carrying
        `locale` and `gender` and accepted the one without them, which narrows
        the cause to exactly those two permissions and separates it from a
        customer who set neither. Both leave the columns empty and only one is
        fixed by an approval.

        Per person rather than once per run because the backfill's whole output
        is these lines: a run where every contact says this and a run where none
        does are the two unambiguous answers.
      */
      if (result.extendedFieldsRefused) {
        console.warn(
          `${prefix}: locale and gender were refused, the rest was not — the Meta app holds ` +
            `Business Asset User Profile Access but not pages_user_locale / ` +
            `pages_user_gender. Check those two under App Review. The name and picture are ` +
            `saved and the identity is stamped, so once they are granted this contact is only ` +
            `revisited by \`npm run job -- backfill_meta_profiles force=true\` — an unforced ` +
            `run selects nothing.`,
        );
      }
      return;
  }
}
