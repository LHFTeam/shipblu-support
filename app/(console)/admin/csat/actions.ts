'use server';

import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { csatRules, groups } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { surveyEmail } from '@/lib/csat/email';
import { MAX_DELAY_MINUTES, MAX_RESURVEY_DAYS, MIN_RESURVEY_DAYS } from '@/lib/csat/limits';
import { wordingForRule } from '@/lib/csat/rules';
import { saveCsatSettings, type CsatSettingsInput } from '@/lib/csat/settings';
import {
  WORDING_FIELDS,
  wordingColumn,
  wordingProblems,
  type WordingPair,
} from '@/lib/csat/wording';
import { enqueueNotificationEmail } from '@/lib/email/notify';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { publicBaseUrl } from '@/lib/kb/site';
import { refresh, type SettingsState } from '../settings-shared';

/**
 * The survey switch, its timing and its channels, saved as one row.
 *
 * One form and one action rather than one per section, because the numbers
 * only mean anything beside the switch they govern, and a page where half the
 * settings saved and half refused is a page the admin has to re-read.
 */

/** A whole number of units within bounds, or the sentence to refuse it with. */
function bounded(
  raw: string,
  label: string,
  max: number,
  min = 0,
): { value: number } | { error: string } {
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value < 0) {
    return { error: `${label} has to be a whole number.` };
  }
  if (value < min) return { error: `${label} has to be at least ${min}.` };
  if (value > max) return { error: `${label} can be at most ${max}.` };
  return { value };
}

export async function saveSurveySettings(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const admin = await requirePermission('admin.csat');

  const delay = bounded(text(formData, 'delayMinutes'), 'The delay', MAX_DELAY_MINUTES);
  if ('error' in delay) return { error: delay.error };

  const metaRaw = text(formData, 'metaDelayMinutes');
  const metaDelay = metaRaw
    ? bounded(metaRaw, 'The Facebook and Instagram delay', MAX_DELAY_MINUTES)
    : { value: null };
  if ('error' in metaDelay) return { error: metaDelay.error };

  const resurvey = bounded(
    text(formData, 'resurveyAfterDays'),
    'The resurvey window',
    MAX_RESURVEY_DAYS,
    MIN_RESURVEY_DAYS,
  );
  if ('error' in resurvey) return { error: resurvey.error };

  const on = (key: string) => formData.get(key) === 'on';

  const input: CsatSettingsInput = {
    enabled: on('enabled'),
    delayMinutes: delay.value,
    metaDelayMinutes: metaDelay.value,
    resurveyAfterDays: resurvey.value,
    channels: {
      email: on('surveyEmail'),
      webchat: on('surveyWebchat'),
      facebook: on('surveyFacebook'),
      instagram: on('surveyInstagram'),
      api: on('surveyApi'),
    },
    surveyRuleResolved: on('surveyRuleResolved'),
  };

  await saveCsatSettings(input, admin.id);
  refresh('/admin/csat');
  return ok();
}

// --- Wording rules ----------------------------------------------------------

/**
 * The channels a wording rule may be scoped to: the ones a survey can go out
 * on. Read from the form and checked against this list rather than cast,
 * because the column is an enum and an unknown value is a Postgres error at
 * write time, not the sentence this form is built to show.
 */
const WORDING_CHANNELS = ['email', 'webchat', 'facebook', 'instagram', 'portal', 'api'] as const;

type WordingChannel = (typeof WORDING_CHANNELS)[number];

function wordingChannel(formData: FormData): WordingChannel | null | undefined {
  const raw = text(formData, 'channel');
  if (!raw) return null;
  return (WORDING_CHANNELS as readonly string[]).includes(raw)
    ? (raw as WordingChannel)
    : undefined;
}

export async function saveWordingRule(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.csat');

  const id = uuidField(formData, 'id');
  const groupId = uuidField(formData, 'groupId');
  if (id === undefined || groupId === undefined) {
    return { error: 'That form is out of date — reload the page and try again' };
  }

  const channel = wordingChannel(formData);
  if (channel === undefined) return { error: 'Pick a channel, or leave it on every channel' };

  // Re-read rather than trusted: a group deleted in another tab reaches the
  // insert as a foreign key violation — a thrown action, which returns no
  // state, rather than a sentence.
  if (groupId) {
    const group = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    if (!group[0]) return { error: 'That group no longer exists' };
  }

  const pair = {} as WordingPair;
  for (const field of WORDING_FIELDS) {
    for (const locale of ['ar', 'en'] as const) {
      const column = wordingColumn(field, locale);
      pair[column] = text(formData, column);
    }
  }

  // The limits are Meta's and a wording that saves must be one that sends;
  // the form counted against the same table as the admin typed, so this is
  // the refusal for what a stale tab or a hand-made POST let through.
  const problems = wordingProblems(pair);
  if (problems.length > 0) return { error: problems.join('. ') };

  const values = {
    groupId,
    channel,
    ...pair,
    isActive: formData.get('isActive') === 'on',
    updatedAt: new Date(),
  };

  // The scope is the identity, so a duplicate is a constraint violation
  // rather than a second row: caught here to say so in words.
  const clash = await db
    .select({ id: csatRules.id })
    .from(csatRules)
    .where(
      and(
        groupId ? eq(csatRules.groupId, groupId) : isNull(csatRules.groupId),
        channel ? eq(csatRules.channel, channel) : isNull(csatRules.channel),
        id ? ne(csatRules.id, id) : undefined,
      ),
    )
    .limit(1);
  if (clash[0]) return { error: 'A rule already covers that group and channel — edit it instead' };

  if (id) {
    await db.update(csatRules).set(values).where(eq(csatRules.id, id));
  } else {
    await db.insert(csatRules).values(values);
  }

  refresh('/admin/csat');
  return ok();
}

export async function deleteWordingRule(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.csat');

  const id = uuidField(formData, 'id');
  if (!id) return { error: 'That form is out of date — reload the page and try again' };

  // Surveys that went out with this wording keep their `rule_id` set null by
  // the key, and their page falls back to the built-in wording.
  await db.delete(csatRules).where(eq(csatRules.id, id));

  refresh('/admin/csat');
  return ok();
}

/**
 * Emails the admin the survey as a customer would get it, with a rule's
 * wording, in one language.
 *
 * Through the ticket-less email job rather than as a survey: there is no
 * ticket to hang one on, and a row the rollup had to ignore is a row the
 * next report forgets to. The five links land on the preview page, which
 * records nothing. Sent to the signed-in admin's own address and nowhere
 * else — the address is not a field.
 */
export async function sendTestSurvey(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const admin = await requirePermission('admin.csat');

  const ruleId = uuidField(formData, 'ruleId');
  if (ruleId === undefined)
    return { error: 'That form is out of date — reload the page and try again' };
  const locale = text(formData, 'locale') === 'ar' ? 'ar' : 'en';

  const wording = await wordingForRule(ruleId, locale);
  const preview = `${publicBaseUrl()}/${locale}/csat/preview${ruleId ? `?rule=${ruleId}` : ''}`;
  const email = surveyEmail(wording, locale, preview);

  await enqueueNotificationEmail({
    to: admin.email,
    subject: `[Test] ${wording.question}`,
    textBody: email.text,
    htmlBody: email.html,
  });

  refresh('/admin/csat');
  return ok();
}
