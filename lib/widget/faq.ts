import type { Locale } from '@/lib/kb/locale';
import { folderArticles, popularArticles } from '@/lib/kb/queries';
import { ANONYMOUS } from '@/lib/kb/visibility';
import { parseWidgetConfig } from './config';
import { webchatChannel } from './session';

/**
 * The questions the widget offers before anyone types.
 *
 * `ANONYMOUS`, always, and for the reason spelled out in `lib/kb/viewer.ts`: the
 * widget authenticates a *visitor* — a token minted for a browser on somebody
 * else's website — which is not the portal session that says who a customer is.
 * Handing it a customer viewer would publish `logged_in` articles to every page
 * that embeds the widget.
 */

/** Six: the most a 380px panel shows without the button below it scrolling off. */
const FAQ_SIZE = 6;

export type WidgetFaq = {
  title: string;
  slug: string;
};

/**
 * Two sources, in order of how much someone meant them.
 *
 * The configured folder is an editor's answer to "what do people ask us", and it
 * wins whenever it has anything in it. `popularArticles` is the fallback, so the
 * widget is useful on the day this ships rather than on the day an admin first
 * opens the channels page — and it is a real fallback here, not a theoretical
 * one: 108 of production's 112 published articles have been opened at least
 * once.
 *
 * Both can legitimately come back empty — a fresh knowledge base, or a folder an
 * editor emptied — and an empty list is a state the home screen renders rather
 * than an error. It simply leads with the search box and the button instead.
 */
export async function widgetFaqs(locale: Locale): Promise<WidgetFaq[]> {
  const channel = await webchatChannel();
  const folderId = parseWidgetConfig(channel?.config).faqFolders[locale];

  if (folderId) {
    const curated = await folderArticles(ANONYMOUS, locale, folderId, FAQ_SIZE);
    if (curated.length > 0) {
      return curated.map(({ title, slug }) => ({ title, slug }));
    }
  }

  const popular = await popularArticles(ANONYMOUS, locale, FAQ_SIZE);
  return popular.map(({ title, slug }) => ({ title, slug }));
}
