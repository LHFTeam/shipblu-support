import { eq } from 'drizzle-orm';
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
 * No row is a fresh install and reads as off with every channel off. A failed
 * read also reads as off, uncached, so the next request tries again — and the
 * job records `csat_off` rather than sending on a guess.
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
  changedAt: null,
  changedBy: null,
};

let cached: { at: number; value: CsatSettings } | null = null;

export async function loadCsatSettings(): Promise<CsatSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
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
        changedAt: csatSettings.updatedAt,
        changedBy: agents.name,
      })
      .from(csatSettings)
      .leftJoin(agents, eq(agents.id, csatSettings.updatedByAgentId))
      .where(eq(csatSettings.id, 1))
      .limit(1);

    const row = rows[0];
    const value: CsatSettings = row
      ? {
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
          changedAt: row.changedAt,
          changedBy: row.changedBy,
        }
      : UNSET_CSAT_SETTINGS;

    cached = { at: Date.now(), value };
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

export type CsatSettingsInput = Omit<CsatSettings, 'changedAt' | 'changedBy'>;

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
    updatedByAgentId,
    updatedAt: new Date(),
  };

  await db
    .insert(csatSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: csatSettings.id, set: values });

  forgetCsatSettings();
}
