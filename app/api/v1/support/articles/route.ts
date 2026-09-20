import { NextResponse } from 'next/server';
import { parseWidgetConfig } from '@/lib/widget/config';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { folderArticles, popularArticles, searchArticles } from '@/lib/kb/queries';
import { publicBaseUrl } from '@/lib/kb/site';
import { ANONYMOUS } from '@/lib/kb/visibility';
import { mobileChannel } from '@/lib/myblu/session';
import { authorise, handle } from '../_shared';

export const dynamic = 'force-dynamic';

const RESULTS = 5;

/**
 * Help articles for the app's support screen, and search over them.
 *
 * Answering before a ticket is opened is the cheapest support there is, and it
 * is the one deflection that does not feel like being fobbed off — the customer
 * asked and got an answer without waiting. myBlu has no help centre of its own
 * today, so this is also the first time any of that content reaches the app.
 *
 * **Read as `ANONYMOUS`, even for a verified session**, and the reason is not
 * the widget's. The widget is anonymous because its token identifies a browser
 * on somebody else's page. A verified myBlu session genuinely is a customer —
 * but the public knowledge base queries still take no viewer, so `logged_in`
 * and `selected_companies` are unevaluated, and an unevaluated visibility rule
 * is treated as deny. Passing a viewer here would mean inventing that machinery
 * for one surface. `selected_companies` is a merchant audience in any case, and
 * a myBlu user is a recipient.
 */
export async function GET(request: Request) {
  return handle(request, async () => {
    const auth = await authorise(request, 'articles', 60);
    if ('error' in auth) return auth.error;

    const params = new URL(request.url).searchParams;
    const requested = params.get('locale') ?? auth.session.locale ?? DEFAULT_LOCALE;
    // The tag only: the app sends `ar` or `en`, but a client sending `ar-EG`
    // should get Arabic rather than the default.
    const tag = requested.split('-')[0]!.toLowerCase();
    const locale = isLocale(tag) ? tag : DEFAULT_LOCALE;

    // `publicBaseUrl()`, not the host this request arrived on. The widget uses
    // the request's host because its links are for somebody already reading a
    // page served from it; these go to a native app and open in the customer's
    // browser, so a link built from the console's hostname is the address they
    // see, share and bookmark. The help centre's own domain is the one that is
    // meant to be public.
    const base = publicBaseUrl();
    const query = (params.get('q') ?? '').trim();

    // Three characters, the same floor the widget's search uses: shorter than
    // that matches most of the corpus and suggests nothing useful.
    const hits =
      query.length >= 3
        ? await searchArticles(ANONYMOUS, locale, query, RESULTS)
        : await curated(locale);

    return NextResponse.json({
      locale,
      articles: hits.map((hit) => ({
        title: hit.title,
        slug: hit.slug,
        // `encodeURI`, because an article slug can be Arabic: ASCII slugify
        // erases it entirely, so these are real UTF-8 slugs that have to survive
        // being put in a URL.
        url: `${base}/${locale}/a/${encodeURI(hit.slug)}`,
      })),
    });
  });
}

/**
 * What the app shows before anybody types.
 *
 * `widgetFaqs()` is the same two-source rule, but it reads the *webchat*
 * channel's configured folder. The app gets its own row's folder so the two
 * surfaces can offer different questions — a recipient asking about a parcel is
 * not a merchant asking about their account — falling back to the most-read
 * list so this is useful before an admin has configured anything.
 */
async function curated(locale: 'ar' | 'en') {
  const channel = await mobileChannel();
  const folderId = parseWidgetConfig(channel?.config).faqFolders[locale];

  if (folderId) {
    const rows = await folderArticles(ANONYMOUS, locale, folderId, RESULTS);
    if (rows.length > 0) return rows;
  }

  return popularArticles(ANONYMOUS, locale, RESULTS);
}
