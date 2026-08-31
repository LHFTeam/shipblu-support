import { LOCALES, type Locale } from '@/lib/kb/locale';

/**
 * The widget's settings, read out of `channels.config` on the `webchat` row.
 *
 * A jsonb column rather than new columns because that is what it is documented
 * for — "non-secret settings only" (`db/schema/config.ts`) — and because the row
 * already exists in production carrying `{"address": ""}`, a leftover from the
 * channel form's catch-all branch. Anything read out of it is therefore
 * untrusted shape: written by an older deploy, hand-edited, or simply absent.
 * Every consumer goes through `parseWidgetConfig`, so an unparseable value
 * degrades to "nothing configured" — which the FAQ list already has a fallback
 * for — rather than throwing inside the iframe.
 */

export type WidgetChannelConfig = {
  /**
   * The KB folder whose articles the widget lists, per locale.
   *
   * Per locale rather than one folder, because `kb_folders` has no locale of its
   * own — it inherits its category's — so one id cannot serve both languages.
   */
  faqFolders: Partial<Record<Locale, string>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWidgetConfig(config: unknown): WidgetChannelConfig {
  const faqFolders: Partial<Record<Locale, string>> = {};

  const raw = isRecord(config) ? config.faqFolders : undefined;
  if (!isRecord(raw)) return { faqFolders };

  for (const locale of LOCALES) {
    const value = raw[locale];
    // Checked rather than cast: the id goes straight into a `where` clause, and
    // a non-uuid there is a Postgres error rather than an empty result.
    if (typeof value === 'string' && UUID.test(value)) faqFolders[locale] = value;
  }

  return { faqFolders };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
