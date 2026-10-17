import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, csatSettings } from '@/db/schema';
import { logger } from '@/lib/log';

const log = logger('csat');

/**
 * The survey switch and its numbers.
 *
 * Read when a ticket resolves and again when its survey job runs, so it is
 * memoised the way `lib/canned-suggest/settings.ts` memoises its switch: per
 * process, for thirty seconds. An admin who flips it sees their own change at
 * once (`forget` after the save) and the worker within the TTL. Switching off
 * is the rollback, so thirty seconds is also how long the rollback takes.
 *
 * No row is a fresh install and reads as off with every channel off. On a
 * page a failed read also reads as off, uncached, so the next request tries
 * again; the job and the sidebar's "Send now" read through `readCsatSettings`,
 * which throws instead, because "off" written on a ticket outlives a hiccup.
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
  /** Messenger's `business_privacy.url`; Facebook is not surveyed while null. */
  privacyUrl: string | null;
  /** Messenger's `expires_in_days` for the feedback card, 1–7. */
  metaExpiresInDays: number;
  /** What Graph said when it last refused the feedback card, or null. */
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
 * For the job and the sidebar's "Send now": a read that failed must fail
 * them, so the queue retries, rather than answer "off" — which the job would
 * record on the ticket as a reason, in a row that outlives the hiccup.
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

/** The settings for a page, memoised; a failed read reads as off, uncached. */
export async function loadCsatSettings(): Promise<CsatSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    cached = { at: Date.now(), value: await readCsatSettings() };
  } catch (error) {
    log.error('could not read the survey settings, treating them as off', error);
    return UNSET_CSAT_SETTINGS;
  }

  return cached.value;
}

/** Drop the memo, so the admin who just saved sees their own change. This process only. */
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
