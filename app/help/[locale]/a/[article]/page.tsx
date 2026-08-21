import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DocumentIcon } from '@/components/icons';
import { formatArticleDate, isLocale, LOCALE_NAMES, t, type Locale } from '@/lib/kb/locale';
import { getArticle, relatedArticles, translationsOf } from '@/lib/kb/queries';
import { decodeSlugParam } from '@/lib/kb/slug';
import { PageBody, PageHeader, Panel } from '../../chrome';
import { ArticleFeedback } from './feedback';
import { PrintButton } from './print-button';
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
    <>
      <ViewBeacon articleId={article.id} />

      <PageHeader
        locale={locale}
        crumbs={[
          { label: t(locale, 'home'), href: `/${locale}` },
          { label: article.categoryName, href: `/${locale}/c/${article.categorySlug}` },
          {
            label: article.folderName,
            href: `/${locale}/c/${article.categorySlug}/${article.folderSlug}`,
          },
        ]}
        title={article.title}
        selfPath={`/${locale}/a/${article.slug}`}
        icon={<DocumentIcon size={28} />}
        meta={
          <>
            {t(locale, 'updated')} {formatArticleDate(locale, article.updatedAt)}
            {others.map((entry) => (
              <span key={entry.locale}>
                {' · '}
                <Link
                  href={`/${entry.locale}/a/${entry.slug}`}
                  lang={entry.locale}
                  hrefLang={entry.locale}
                  className="underline underline-offset-4"
                >
                  {LOCALE_NAMES[entry.locale as Locale] ?? entry.locale}
                </Link>
              </span>
            ))}
          </>
        }
      />

      <PageBody>
        {/*
          One column on a phone, prose then sidebar. From `lg` the sidebar is a
          fixed 17rem and the prose takes what is left, which keeps the measure
          roughly constant instead of stretching with the viewport — long lines
          are the fastest way to make somebody lose their place mid-procedure.
        */}
        <div
          className={`grid grid-cols-1 gap-5 ${
            related.length > 0 ? 'lg:grid-cols-[minmax(0,1fr)_17rem]' : ''
          }`}
        >
          {/*
            `min-w-0` is not decoration. A grid track sized `auto` takes its floor
            from the item's min-content width, and an imported article's widest
            code block or table sets that floor several hundred pixels past a
            phone viewport — the track grows, and the whole document scrolls
            sideways instead of the code block scrolling inside itself.
          */}
          <article className="min-w-0">
            <Panel className="p-5 sm:p-8">
              <div className="mb-4 flex justify-end">
                <PrintButton locale={locale} />
              </div>

              {/*
                Sanitised on write, in the console action and in the importer,
                never here — so the stored row is safe for every consumer rather
                than only for this page. Re-sanitising on read would hide a gap
                upstream.
              */}
              <div className="kb-article" dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />

              <div className="mt-10 border-t border-[var(--kb-border)] pt-6">
                <ArticleFeedback articleId={article.id} locale={locale} />
              </div>
            </Panel>
          </article>

          {related.length > 0 ? (
            <Panel as="aside" className="kb-noprint h-fit p-5 lg:sticky lg:top-20">
              <h2 className="text-sm font-semibold text-[var(--kb-heading)]">
                {t(locale, 'inThisFolder')}
              </h2>
              <ul className="mt-3 flex flex-col gap-3 text-sm">
                {related.map((entry) => (
                  <li key={entry.id}>
                    <Link
                      href={`/${locale}/a/${entry.slug}`}
                      className="flex items-start gap-2 text-[var(--kb-link)] underline-offset-4 hover:underline"
                    >
                      <DocumentIcon size={17} className="mt-0.5 shrink-0 text-[var(--kb-muted)]" />
                      <span className="min-w-0">{entry.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>
      </PageBody>
    </>
  );
}
