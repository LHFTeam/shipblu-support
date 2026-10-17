import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, csatSettings } from '@/db/schema';
import { logger } from '@/lib/log';

const log = logger('csat');

/**
 * The survey switch and its numbers.
 *
 * Two readers, for two kinds of caller. Everything that acts on the settings
 * reads them uncached through `readCsatSettings`, which throws when the read
 * fails: the resolve that schedules a survey, the job that sends it — so
 * switching off, the rollback, reaches the next resolve at once — and the
 * admin form, which is saved back whole and so must never be drawn from a
 * stale copy or from a failed read taken as all-off. "Off" written on a
 * ticket, or saved over the real settings, outlives a hiccup.
 *
 * Only the ticket sidebar, which reads them on every render to decide whether
 * to offer "Send now", goes through `loadCsatSettings`: memoised per process
 * for thirty seconds, the way `lib/canned-suggest/settings.ts` memoises its
 * switch. A failed read there is null, uncached: the sidebar then says the
 * settings could not be read, never that surveys are off, which is a claim
 * about what an admin did.
 *
 * No row is a fresh install and reads as off with every channel off.
 */

const CACHE_TTL_MS = 30_000;

export type CsatChannels = {
  email: boolean;
  webchat: boolean;
  facebook: boolean;
  instagram: boolean;
  api: boolean;
};

export type CsatSettings = {
  enabled: boolean;
  delayMinutes: number;
  /** Facebook and Instagram's own delay, or null for `delayMinutes`. */
  metaDelayMinutes: number | null;
  resurveyAfterDays: number;
  channels: CsatChannels;
  surveyRuleResolved: boolean;
  /** Whether a 1 or 2 emails the supervisors (`lib/csat/low-rating.ts`). */
  lowRatingAlerts: boolean;
  /**
   * Messenger's `business_privacy.url`. No card is sent while null: Facebook
   * gets the rating buttons inside the 24 hours and is skipped past them.
   */
  privacyUrl: string | null;
  /** Messenger's `expires_in_days` for the feedback card, 1–7. */
  metaExpiresInDays: number;
  /**
   * What Graph said when it last refused the feedback card, or null. Cleared
   * by a card that goes out, and stops counting a day after `at`
   * (`cardRefusalStands`).
   */
  lastTemplateRefusal: { text: string; at: Date } | null;
  /** When it last changed and by whom — null before the first save. */
  changedAt: Date | null;
  changedBy: string | null;
};

export const UNSET_CSAT_SETTINGS: CsatSettings = {
  enabled: false,
  delayMinutes: 30,
  metaDelayMinutes: null,
  resurveyAfterDays: 14,
  channels: { email: false, webchat: false, facebook: false, instagram: false, api: false },
  surveyRuleResolved: true,
  lowRatingAlerts: true,
  privacyUrl: null,
  metaExpiresInDays: 3,
  lastTemplateRefusal: null,
  changedAt: null,
  changedBy: null,
};

let cached: { at: number; value: CsatSettings } | null = null;

/**
 * The settings as the row holds them, now, or the error the read raised.
 *
 * For the resolve, the job, "Send now" and the admin form: a read that failed
 * must fail them — the queue retries, the page errors — rather than answer
 * "off", which the job would record on the ticket as a reason and the form
 * would save over the real settings.
 */
export async function readCsatSettings(): Promise<CsatSettings> {
  const rows = await db
    .select({
      enabled: csatSettings.enabled,
      delayMinutes: csatSettings.delayMinutes,
      metaDelayMinutes: csatSettings.metaDelayMinutes,
      resurveyAfterDays: csatSettings.resurveyAfterDays,
      surveyEmail: csatSettings.surveyEmail,
      surveyWebchat: csatSettings.surveyWebchat,
      surveyFacebook: csatSettings.surveyFacebook,
      surveyInstagram: csatSettings.surveyInstagram,
      surveyApi: csatSettings.surveyApi,
      surveyRuleResolved: csatSettings.surveyRuleResolved,
      lowRatingAlerts: csatSettings.lowRatingAlerts,
      privacyUrl: csatSettings.privacyUrl,
      metaExpiresInDays: csatSettings.metaExpiresInDays,
      lastTemplateRefusal: csatSettings.lastTemplateRefusal,
      lastTemplateRefusalAt: csatSettings.lastTemplateRefusalAt,
      changedAt: csatSettings.updatedAt,
      changedBy: agents.name,
    })
    .from(csatSettings)
    .leftJoin(agents, eq(agents.id, csatSettings.updatedByAgentId))
    .where(eq(csatSettings.id, 1))
    .limit(1);

  const row = rows[0];
  if (!row) return UNSET_CSAT_SETTINGS;
  return {
    enabled: row.enabled,
    delayMinutes: row.delayMinutes,
    metaDelayMinutes: row.metaDelayMinutes,
    resurveyAfterDays: row.resurveyAfterDays,
    channels: {
      email: row.surveyEmail,
      webchat: row.surveyWebchat,
      facebook: row.surveyFacebook,
      instagram: row.surveyInstagram,
      api: row.surveyApi,
    },
    surveyRuleResolved: row.surveyRuleResolved,
    lowRatingAlerts: row.lowRatingAlerts,
    privacyUrl: row.privacyUrl,
    metaExpiresInDays: row.metaExpiresInDays,
    lastTemplateRefusal:
      row.lastTemplateRefusal && row.lastTemplateRefusalAt
        ? { text: row.lastTemplateRefusal, at: row.lastTemplateRefusalAt }
        : null,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
  };
}

/** The settings for the ticket sidebar, memoised; null, uncached, when the read failed. */
export async function loadCsatSettings(): Promise<CsatSettings | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    cached = { at: Date.now(), value: await readCsatSettings() };
  } catch (error) {
    log.error('could not read the survey settings', error);
    return null;
  }

  return cached.value;
}

/**
 * Drop the memo, so the ticket sidebar on the process that saved offers "Send
 * now" by the new settings at once. This process only; elsewhere it takes up
 * to the TTL.
 */
export function forgetCsatSettings(): void {
  cached = null;
}

export type CsatSettingsInput = Omit<
  CsatSettings,
  'changedAt' | 'changedBy' | 'lastTemplateRefusal'
>;

/** Write the single row, creating it the first time. */
export async function saveCsatSettings(
  input: CsatSettingsInput,
  updatedByAgentId: string,
): Promise<void> {
  const values = {
    enabled: input.enabled,
    delayMinutes: input.delayMinutes,
    metaDelayMinutes: input.metaDelayMinutes,
    resurveyAfterDays: input.resurveyAfterDays,
    surveyEmail: input.channels.email,
    surveyWebchat: input.channels.webchat,
    surveyFacebook: input.channels.facebook,
    surveyInstagram: input.channels.instagram,
    surveyApi: input.channels.api,
    surveyRuleResolved: input.surveyRuleResolved,
    lowRatingAlerts: input.lowRatingAlerts,
    privacyUrl: input.privacyUrl,
    metaExpiresInDays: input.metaExpiresInDays,
    updatedByAgentId,
    updatedAt: new Date(),
  };

  await db
    .insert(csatSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: csatSettings.id, set: values });

  forgetCsatSettings();
}

/**
 * Graph refused Messenger's feedback card: keep what it said, for the admin
 * page. Not a change anybody made, so the "last changed" line is left alone,
 * and the page shows it on its next read of the row. No row means surveys
 * were never switched on, and nothing could have been refused.
 */
export async function recordTemplateRefusal(text: string): Promise<void> {
  await db
    .update(csatSettings)
    .set({ lastTemplateRefusal: text.slice(0, 2000), lastTemplateRefusalAt: new Date() })
    .where(eq(csatSettings.id, 1));
}

/**
 * Messenger took the card: the last refusal is history, and the admin page's
 * warning comes down. One indexed write that changes nothing in the steady
 * state, where there is no refusal to clear.
 */
export async function clearTemplateRefusal(): Promise<void> {
  await db
    .update(csatSettings)
    .set({ lastTemplateRefusal: null, lastTemplateRefusalAt: null })
    .where(and(eq(csatSettings.id, 1), isNotNull(csatSettings.lastTemplateRefusal)));
}
