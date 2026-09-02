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

/** A folder as the FAQ picker needs it, whatever query produced it. */
export type FaqFolderOption = {
  id: string;
  name: string;
  categoryName: string;
  categoryLocale: string;
  visibility: string;
};

/**
 * The folders the widget may be pointed at.
 *
 * One home for the rule, because it is needed twice — the admin page builds the
 * picker from it and `saveChannel` refuses anything outside it — and a picker
 * that offered more than the action accepted would present a choice that fails
 * on save, while one that offered less would hide a legitimate folder.
 *
 * Non-public folders are excluded rather than shown and rejected: the widget
 * reads with an anonymous viewer, so an `agents_only` folder yields an empty
 * panel for the customer while looking configured on the admin's screen.
 * Production's Arabic staff handbook is four such folders whose articles are
 * each marked `published`/`public`, which is what makes the mistake plausible
 * rather than theoretical.
 */
export function offerableFaqFolders<T extends { visibility: string }>(folders: T[]): T[] {
  return folders.filter((folder) => folder.visibility === 'public');
}

export type FaqFolderProblem = { error: string } | { folders: Record<string, string> };

/**
 * Validates a chosen folder per locale against what is actually offerable.
 *
 * Re-read rather than trusted, like every other id arriving in a `FormData`
 * field — and with the locale checked too, because a folder has no locale of
 * its own and takes its category's, so the slot it was offered under is the only
 * thing that ties it to a language.
 */
export function resolveFaqFolders(
  chosenPerLocale: Partial<Record<Locale, string>>,
  folders: FaqFolderOption[],
): FaqFolderProblem {
  const offerable = offerableFaqFolders(folders);
  const resolved: Record<string, string> = {};

  for (const locale of LOCALES) {
    const chosen = chosenPerLocale[locale];
    if (!chosen) continue;

    const folder = folders.find((row) => row.id === chosen);
    if (!folder) return { error: 'That knowledge base folder no longer exists' };
    if (folder.categoryLocale !== locale) {
      return { error: `${folder.name} is not in a ${locale} category` };
    }
    if (!offerable.some((row) => row.id === chosen)) {
      return { error: `${folder.name} is not public, so the widget would show nothing from it` };
    }

    resolved[locale] = chosen;
  }

  return { folders: resolved };
}
