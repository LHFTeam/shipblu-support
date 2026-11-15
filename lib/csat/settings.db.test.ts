import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, csatSettings } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { saveCsatSettings, UNSET_CSAT_SETTINGS } from './settings';

withCleanDatabase();

async function admin(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', role: 'admin', passwordHash: 'x' })
    .returning({ id: agents.id });
  return row!.id;
}

async function storedSurveyApi(): Promise<boolean | undefined> {
  const [row] = await db.select({ surveyApi: csatSettings.surveyApi }).from(csatSettings);
  return row?.surveyApi;
}

/**
 * The settings form posts no switch for the myBlu app until stage 8, so a save
 * that leaves `api` out keeps what is stored, rather than switching the app
 * off, or on, by a field nobody saw.
 */
describe('saveCsatSettings and the myBlu app’s switch', () => {
  it('keeps survey_api as stored when the save leaves it out, and writes it when named', async () => {
    const by = await admin();
    await saveCsatSettings(
      { ...UNSET_CSAT_SETTINGS, channels: { ...UNSET_CSAT_SETTINGS.channels, api: true } },
      by,
    );
    expect(await storedSurveyApi()).toBe(true);

    const { api: _, ...withoutApi } = UNSET_CSAT_SETTINGS.channels;
    await saveCsatSettings({ ...UNSET_CSAT_SETTINGS, enabled: true, channels: withoutApi }, by);
    expect(await storedSurveyApi()).toBe(true);

    await saveCsatSettings(
      { ...UNSET_CSAT_SETTINGS, channels: { ...UNSET_CSAT_SETTINGS.channels, api: false } },
      by,
    );
    expect(await storedSurveyApi()).toBe(false);
  });

  it('writes the column default on a first save that leaves it out', async () => {
    const { api: _, ...withoutApi } = UNSET_CSAT_SETTINGS.channels;
    await saveCsatSettings({ ...UNSET_CSAT_SETTINGS, channels: withoutApi }, await admin());
    expect(await storedSurveyApi()).toBe(false);
  });
});
