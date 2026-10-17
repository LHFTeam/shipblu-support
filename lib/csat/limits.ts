import { MAX_EXPIRES_IN_DAYS, MIN_EXPIRES_IN_DAYS } from '@/lib/meta/feedback-template';

/**
 * The bounds on the survey's numbers, shared by the admin form's native
 * validation and the action that refuses what the browser let through. Two
 * copies drifted apart would have the browser refuse a value the server
 * accepts, or the other way round. Pure, so the form's client bundle can hold
 * it without the settings module's database client.
 *
 * The resurvey window has a floor of a day: at zero, "surveyed inside the
 * window" is never true, and every job for a ticket — the scheduled one and
 * a "Send now" beside it — would survey the customer again.
 */
export const MAX_DELAY_MINUTES = 7 * 24 * 60;
/** Messenger's `expires_in_days`, from beside the request that sends it. */
export const MIN_META_EXPIRY_DAYS = MIN_EXPIRES_IN_DAYS;
export const MAX_META_EXPIRY_DAYS = MAX_EXPIRES_IN_DAYS;
export const MIN_RESURVEY_DAYS = 1;
export const MAX_RESURVEY_DAYS = 365;

/**
 * The longest comment kept, in characters. The routes cut what they are sent
 * to it and the chat card's box stops there, so the visitor sees where the
 * end is rather than finding their last sentence gone.
 */
export const MAX_COMMENT = 2000;

/**
 * The privacy link Messenger's card carries, or the sentence to refuse it
 * with. A full `https://` address: Meta shows it to the customer as the
 * business's privacy policy, and a relative path or a typo has nowhere to go.
 */
export function privacyUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'The privacy link has to be a full address, starting https://.';
  }
  return url.protocol === 'https:' ? null : 'The privacy link has to start https://.';
}
