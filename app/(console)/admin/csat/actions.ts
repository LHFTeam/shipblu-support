'use server';

import { requirePermission } from '@/lib/auth/guard';
import { MAX_DELAY_MINUTES, MAX_RESURVEY_DAYS, MIN_RESURVEY_DAYS } from '@/lib/csat/limits';
import { saveCsatSettings, type CsatSettingsInput } from '@/lib/csat/settings';
import { ok } from '@/lib/http/action-state';
import { text } from '@/lib/http/form-data';
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
