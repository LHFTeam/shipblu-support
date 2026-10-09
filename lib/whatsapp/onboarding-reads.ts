import { desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ONBOARDING_STEPS, type OnboardingStatus, whatsappOnboardings } from '@/db/schema';
import { canonicalUuid } from '@/lib/http/uuid';
import { type OnboardingView, toOnboardingView } from './onboarding-view';

/**
 * What the admin page and its actions read of the attempts to connect WhatsApp
 * numbers — and the one rule about them the job shares (`runsNamedSteps`).
 *
 * In `lib/` rather than beside the page so the database tier can run it
 * (`page-db`): `distinct on` is the one shape here that only Postgres can
 * judge, and the test beside this file puts it in front of real Postgres.
 */

/**
 * The latest attempt for each number, newest first — one card per number on
 * the page, whatever its state, so a failed attempt is not hidden behind the
 * connected one before it and a reconnect replaces the card of the connection
 * it replaced.
 *
 * `distinct on (phone_number_id)` with `started_at desc` is what makes it the
 * latest, and the `(phone_number_id, started_at desc)` index is what makes
 * it cheap; a retry moves `started_at`, so the attempt being retried is the
 * one shown.
 */
export async function listLatestOnboardings(): Promise<OnboardingView[]> {
  const rows = await db
    .selectDistinctOn([whatsappOnboardings.phoneNumberId], {
      id: whatsappOnboardings.id,
      status: whatsappOnboardings.status,
      steps: whatsappOnboardings.steps,
      attempts: whatsappOnboardings.attempts,
      nextAttemptAt: whatsappOnboardings.nextAttemptAt,
      lastTransientError: whatsappOnboardings.lastTransientError,
      error: whatsappOnboardings.error,
      channelId: whatsappOnboardings.channelId,
      phoneNumberId: whatsappOnboardings.phoneNumberId,
      wabaId: whatsappOnboardings.wabaId,
      startedAt: whatsappOnboardings.startedAt,
      finishedAt: whatsappOnboardings.finishedAt,
      startedByLabel: whatsappOnboardings.startedByLabel,
    })
    .from(whatsappOnboardings)
    .orderBy(whatsappOnboardings.phoneNumberId, desc(whatsappOnboardings.startedAt));

  return rows
    .map((row) => toOnboardingView(row, ONBOARDING_STEPS))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Whether the job runs named steps alone — "Copy history" on a channel row is
 * a run of `['history']` — on an attempt in this state: only on one that
 * finished connecting. A full run is for an attempt still connecting, and an
 * attempt that failed or was replaced has no connection to ask through.
 *
 * One predicate for the job's gate and the button's action, because they
 * disagreed: the action enqueued a run the job then skipped in silence, while
 * the page told the admin the copy was on its way.
 */
export function runsNamedSteps(status: OnboardingStatus): boolean {
  return status === 'connected';
}

/**
 * Why the copy cannot be asked for through the attempt a channel names
 * (`coexistence.onboardingId`), or null when it can — the job's own gate, read
 * before anything is enqueued so the refusal is a sentence on the row rather
 * than a log line in the worker.
 *
 * A read the click can race: the job judges again when it runs. What it closes
 * is the case that is not a race at all — an attempt still connecting, whose
 * channel step has written the object the copy buttons read, and which may sit
 * in the queue's backoff for minutes.
 */
export async function copyRequestRefusal(onboardingId: string): Promise<string | null> {
  // The id comes out of jsonb, which a person may have written; Postgres
  // answers a malformed uuid with 22P02, and the button with a crash.
  const id = canonicalUuid(onboardingId);
  const [row] = id
    ? await db
        .select({ status: whatsappOnboardings.status })
        .from(whatsappOnboardings)
        .where(eq(whatsappOnboardings.id, id))
        .limit(1)
    : [];

  if (!row) {
    return (
      'The connection that set this number up is no longer recorded, so there is nothing to ' +
      'ask the phone through. Reconnect the number through Meta to open a new copy window.'
    );
  }
  if (runsNamedSteps(row.status)) return null;

  if (row.status === 'exchanged') {
    return (
      "This number's connection has not finished yet, and asking the phone for the copy is " +
      'one of its steps — the progress card above shows where it is. Once it has finished, ' +
      'the copy buttons on this row are for whatever that step could not get.'
    );
  }
  return (
    'The connection attempt that set this number up was replaced by a newer one, so the copy ' +
    'cannot be asked for through it. If the newer attempt is still connecting, the copy is ' +
    'one of its steps; otherwise reconnect the number through Meta to open a new copy window.'
  );
}
