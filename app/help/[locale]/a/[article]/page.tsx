import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { formatArticleDate, isLocale, LOCALE_NAMES, t, type Locale } from '@/lib/kb/locale';
import { getArticle, relatedArticles, translationsOf } from '@/lib/kb/queries';
import { decodeSlugParam } from '@/lib/kb/slug';
import { ArticleFeedback } from './feedback';
import { ViewBeacon } from './view-beacon';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; article: string }>;
}): Promise<Metadata> {
  const { locale, article: articleParam } = await params;
  const slug = decodeSlugParam(articleParam);
  if (!isLocale(locale)) return {};

  const article = await getArticle(locale, slug);
  if (!article) return {};

  const translations = await translationsOf(article.translationGroupId);

  return {
    title: article.seo.title ?? `${article.title} — ShipBlu Support`,
    description: article.seo.description ?? article.excerpt ?? undefined,
    alternates: {
      canonical: `/${locale}/a/${article.slug}`,
      // Tells search engines these are translations of one another rather than
      // duplicates, which is what stops the Arabic page cannibalising the
      // English one in results.
      languages: Object.fromEntries(
        translations.map((entry) => [entry.locale, `/${entry.locale}/a/${entry.slug}`]),
      ),
    },
    openGraph: {
      title: article.title,
      description: article.excerpt ?? undefined,
      type: 'article',
      locale,
    },
  };
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ locale: string; article: string }>;
}) {
  const { locale, article: articleParam } = await params;
  const slug = decodeSlugParam(articleParam);
  if (!isLocale(locale)) notFound();

  const article = await getArticle(locale, slug);
  if (!article) notFound();

  const [related, translations] = await Promise.all([
    relatedArticles(article.folderId, article.id),
    translationsOf(article.translationGroupId),
  ]);

  const others = translations.filter((entry) => entry.locale !== locale);

  return (
    <article>
      <ViewBeacon articleId={article.id} />

      <nav className="mb-4 flex flex-wrap items-center gap-2 text-sm opacity-60">
        <Link href={`/${locale}`} className="hover:opacity-100">
          {t(locale, 'home')}
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/${locale}/c/${article.categorySlug}`} className="hover:opacity-100">
          {article.categoryName}
        </Link>
        <span aria-hidden>/</span>
        <Link
          href={`/${locale}/c/${article.categorySlug}/${article.folderSlug}`}
          className="hover:opacity-100"
        >
          {article.folderName}
        </Link>
      </nav>

      <h1 className="text-2xl font-semibold">{article.title}</h1>

      <p className="mt-1 text-sm opacity-50">
        {t(locale, 'updated')} {formatArticleDate(locale, article.updatedAt)}
      </p>

      {others.length > 0 ? (
        <p className="mt-2 text-sm">
          {others.map((entry) => (
            <Link
              key={entry.locale}
              href={`/${entry.locale}/a/${entry.slug}`}
              lang={entry.locale}
              className="underline underline-offset-4 opacity-70 hover:opacity-100"
            >
              {LOCALE_NAMES[entry.locale as Locale] ?? entry.locale}
            </Link>
          ))}
        </p>
      ) : null}

      {/*
        Sanitised on write, in the console action and in the importer, never
        here — so the stored row is safe for every consumer rather than only for
        this page. Re-sanitising on read would hide a gap upstream.
      */}
      <div className="kb-article mt-6" dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />

      <ArticleFeedback articleId={article.id} locale={locale} />

      {related.length > 0 ? (
        <section className="mt-10 border-t border-[var(--border)] pt-6">
          <h2 className="mb-3 text-sm font-medium opacity-70">{t(locale, 'relatedArticles')}</h2>
          <ul className="flex flex-col gap-2">
            {related.map((entry) => (
              <li key={entry.id}>
                <Link
                  href={`/${locale}/a/${entry.slug}`}
                  className="text-sm underline underline-offset-4 opacity-80 hover:opacity-100"
                >
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
