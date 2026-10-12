'use client';

import { useEffect, useRef, useState } from 'react';
import { DocumentIcon, SearchIcon } from '@/components/icons';
import { Button } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import type { WidgetCopy } from './copy';
import { WIDGET_FIELD } from './field';
import type { ArticleLink } from '@/lib/widget/types';

/**
 * The screen the launcher opens onto.
 *
 * Questions first, a person second. Most of what a visitor opens the widget to
 * ask has already been written down, and reading the answer costs them no wait
 * and us no ticket — but only if the answer is on screen before they start
 * typing. Once they have to compose a sentence, they have decided to talk to
 * somebody, and an article offered after that reads as a brush-off.
 */
export function WidgetHome({
  locale,
  copy,
  faqs,
  online,
  onOpenArticle,
  onTalkToAgent,
}: {
  locale: Locale;
  copy: WidgetCopy;
  faqs: ArticleLink[];
  online: boolean;
  onOpenArticle: (article: ArticleLink) => void;
  onTalkToAgent: () => void;
}) {
  const [query, setQuery] = useState('');

  /*
   * Hits are stored with the query that produced them, rather than beside a
   * `searching` flag.
   *
   * A flag would have to be raised in the effect body, and a synchronous
   * setState there cascades a render — the same reason the composer's
   * suggestion strip filters on render instead of clearing state. Keeping the
   * query alongside its answer makes "has this settled" a comparison rather than
   * a second piece of state that can disagree with the first.
   */
  const [hits, setHits] = useState<{ query: string; articles: ArticleLink[] }>({
    query: '',
    articles: [],
  });

  const trimmed = query.trim();
  // Three characters, which is the endpoint's own floor. The composer's strip
  // waits for six because a half-typed message is not a query; this box is the
  // visitor's whole question, so it answers as soon as it can.
  const searchable = trimmed.length >= 3;

  /*
   * The query the last *dispatched* request was for.
   *
   * Responses can arrive out of order — "ship" fired before "shipment" can
   * answer after it — and storing whichever lands last would leave `hits.query`
   * naming a query the visitor has moved past. Nothing would re-fire, because
   * the debounce for the current query already ran, so the panel would sit
   * blank until they typed another character. Ignoring a response that is no
   * longer the outstanding one costs nothing and cannot strand the list.
   */
  const outstanding = useRef('');

  useEffect(() => {
    if (trimmed.length < 3) return;

    const timer = setTimeout(() => {
      outstanding.current = trimmed;

      void fetch(`/api/widget/search?q=${encodeURIComponent(trimmed)}&locale=${locale}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (outstanding.current !== trimmed) return;
          setHits({ query: trimmed, articles: (data?.articles as ArticleLink[]) ?? [] });
        })
        .catch(() => {
          if (outstanding.current === trimmed) setHits({ query: trimmed, articles: [] });
        });
    }, 300);

    return () => clearTimeout(timer);
  }, [trimmed, locale]);

  const settled = hits.query === trimmed;

  /*
   * The FAQ list stays up while a search is in flight.
   *
   * Blanking it on the third keystroke — and again on every keystroke after —
   * leaves the panel empty for the debounce plus a round trip, which reads as
   * the widget breaking rather than as it thinking. The list it replaces is the
   * better thing to look at in the meantime.
   */
  const showing = searchable && settled ? hits.articles : faqs;
  const heading = searchable && settled ? copy.searchResults : copy.faqHeading;
  const empty = searchable && settled && hits.articles.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="relative">
          <SearchIcon
            size={16}
            className="pointer-events-none absolute inset-y-0 start-2.5 my-auto text-(--color-text-tertiary)"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(locale, 'searchPlaceholder')}
            aria-label={t(locale, 'searchPlaceholder')}
            /* 16px for the same reason as the composer (see ./field). */
            className={`${WIDGET_FIELD} py-2 ps-8 pe-3`}
          />
        </div>

        {showing.length > 0 ? (
          <>
            <p className="mt-4 mb-1 text-xs text-(--color-text-secondary)">{heading}</p>
            <ul className="flex flex-col">
              {showing.map((article) => (
                <li key={article.slug}>
                  <button
                    type="button"
                    onClick={() => onOpenArticle(article)}
                    className="flex w-full items-center gap-3 rounded-md p-2 text-start text-sm transition-colors hover:bg-(--color-background-hover)"
                  >
                    <DocumentIcon size={16} className="shrink-0 text-(--color-text-tertiary)" />
                    <span className="min-w-0 flex-1">{article.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {empty ? (
          <p className="mt-6 text-center text-sm text-(--color-text-secondary)">
            {t(locale, 'noResults')}
          </p>
        ) : null}

        {/* A knowledge base with nothing published in this locale, and a search
            that has not run yet, look the same from here — so say the one thing
            that is true either way rather than an empty heading. */}
        {!searchable && faqs.length === 0 ? (
          <p className="mt-8 text-center text-sm text-(--color-text-secondary)">{copy.starter}</p>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-(--color-border-subtle) p-3">
        <p className="mb-2 text-center text-xs text-(--color-text-secondary)">
          {t(locale, 'contactPrompt')}
        </p>
        {/* `!` because the button's own height is a minimum too, and which of two
            utilities on one property wins is Tailwind's call, not the order here. */}
        <Button onClick={onTalkToAgent} className="min-h-(--tap-min)! w-full">
          {online ? copy.talkToAgent : copy.leaveMessage}
        </Button>
      </div>
    </div>
  );
}
