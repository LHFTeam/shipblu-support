'use client';

import { useEffect, useRef, useState } from 'react';
import { t, type Locale } from '@/lib/kb/locale';
import type { WidgetCopy } from './copy';
import type { ArticleLink } from './types';

type Loaded = { id: string; title: string; bodyHtml: string; url: string };

/**
 * An article, read without leaving the panel.
 *
 * The body is injected as stored. It was sanitised on write — every path that
 * writes `kb_articles.body_html` goes through `lib/html/sanitize.ts` — and
 * sanitising again here would be the read-side habit that eventually excuses an
 * unsanitised write.
 */
export function WidgetArticle({
  locale,
  copy,
  article,
  onBack,
  onTalkToAgent,
}: {
  locale: Locale;
  copy: WidgetCopy;
  article: ArticleLink;
  onBack: () => void;
  onTalkToAgent: () => void;
}) {
  /*
   * The fetch result, tagged with the slug it belongs to.
   *
   * Tagged rather than cleared when `article` changes, because clearing would be
   * a synchronous setState in the effect body — a cascading render, and the
   * thing this file's neighbours go out of their way to avoid. Comparing slugs
   * also makes a slow response for the previous article unable to paint over the
   * one the visitor is now looking at.
   */
  const [fetched, setFetched] = useState<{ slug: string; data: Loaded | null } | null>(null);
  const body = useRef<HTMLDivElement>(null);

  const settled = fetched?.slug === article.slug ? fetched : null;
  const loaded = settled?.data ?? null;
  const failed = settled !== null && settled.data === null;

  useEffect(() => {
    const slug = article.slug;

    void fetch(`/api/widget/article?slug=${encodeURIComponent(slug)}&locale=${locale}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Loaded | null) => setFetched({ slug, data }))
      .catch(() => setFetched({ slug, data: null }));
  }, [article.slug, locale]);

  /*
   * Count the read, the same way the help centre's article page does.
   *
   * The same public, rate-limited endpoint, so the widget cannot inflate a count
   * the help centre could not. It matters because `popularArticles` is what the
   * FAQ list falls back to when no folder is configured: leaving widget reads
   * uncounted would mean the list that exists to answer common questions never
   * learned which ones those were.
   */
  useEffect(() => {
    if (!loaded) return;
    void fetch('/api/kb/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: loaded.id }),
    }).catch(() => {});
  }, [loaded]);

  /*
   * Links inside the body must leave the iframe, not navigate it.
   *
   * An `<a href>` in article HTML carries no target, so a click would replace
   * the widget with a help centre page rendered into a 380px box — no launcher,
   * no back button, and no way to return short of reloading the host page. The
   * handler is delegated to the container rather than rewritten into the HTML so
   * that nothing has to mutate a sanitised body to make it safe to click.
   */
  useEffect(() => {
    const container = body.current;
    if (!container) return;

    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a');
      const href = anchor?.getAttribute('href');
      if (!href) return;

      event.preventDefault();
      // Same-document jumps have nowhere to open and would land on a blank tab.
      if (href.startsWith('#')) {
        container.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      window.open(anchor!.href, '_blank', 'noopener,noreferrer');
    };

    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [loaded]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <h2 className="mb-2 text-base font-semibold">{loaded?.title ?? article.title}</h2>

        {failed ? (
          <p className="py-8 text-center text-sm opacity-50">{t(locale, 'noResults')}</p>
        ) : loaded ? (
          <>
            <div
              ref={body}
              className="widget-article"
              dangerouslySetInnerHTML={{ __html: loaded.bodyHtml }}
            />
            <a
              href={loaded.url}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block text-xs text-brand-600 underline underline-offset-2"
            >
              {copy.readMore}
            </a>
          </>
        ) : (
          <p className="py-8 text-center text-sm opacity-40">…</p>
        )}
      </div>

      {/* The button belongs under the answer, not above it: this is where the
          visitor arrives when the article did not settle their question. */}
      <div className="shrink-0 border-t border-[var(--border)] p-3">
        <p className="mb-2 text-center text-xs opacity-60">{t(locale, 'contactPrompt')}</p>
        <button
          type="button"
          onClick={onTalkToAgent}
          className="w-full rounded-md bg-brand-600 px-3 py-2.5 text-sm font-medium text-white"
        >
          {copy.talkToAgent}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="mt-1 w-full rounded-md px-3 py-1.5 text-xs opacity-60 hover:opacity-100"
        >
          {copy.back}
        </button>
      </div>
    </div>
  );
}
