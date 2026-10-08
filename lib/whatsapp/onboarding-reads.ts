import { desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { ONBOARDING_STEPS, whatsappOnboardings } from '@/db/schema';
import { type OnboardingView, toOnboardingView } from './onboarding-view';

/**
 * What the admin page reads of the attempts to connect WhatsApp numbers.
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
