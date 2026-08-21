import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { CategoryIcon, DocumentIcon, FolderIcon } from '@/components/icons';
import { articleCount, formatCount, isLocale, t, type Locale } from '@/lib/kb/locale';
import { getCategory, type FolderSummary } from '@/lib/kb/queries';
import { decodeSlugParam } from '@/lib/kb/slug';
import { EmptyNote, PageBody, PageHeader, Panel } from '../../chrome';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; category: string }>;
}): Promise<Metadata> {
  const { locale, category: categoryParam } = await params;
  const slug = decodeSlugParam(categoryParam);
  if (!isLocale(locale)) return {};

  const category = await getCategory(locale, slug);
  if (!category) return {};

  return {
    title: `${category.name} — ShipBlu Support`,
    description: category.description ?? undefined,
    alternates: { canonical: `/${locale}/c/${category.slug}` },
  };
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ locale: string; category: string }>;
}) {
  const { locale, category: categoryParam } = await params;
  const slug = decodeSlugParam(categoryParam);
  if (!isLocale(locale)) notFound();

  const category = await getCategory(locale, slug);
  if (!category) notFound();

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[{ label: t(locale, 'home'), href: `/${locale}` }]}
        title={category.name}
        selfPath={`/${locale}/c/${category.slug}`}
        icon={<CategoryIcon size={28} />}
        meta={category.description}
      />

      <PageBody>
        {category.folders.length === 0 ? (
          <EmptyNote>{t(locale, 'emptyCategory')}</EmptyNote>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {category.folders.map((folder) => (
              <FolderPanel
                key={folder.id}
                locale={locale}
                categorySlug={category.slug}
                folder={folder}
              />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}

/**
 * A folder, with the first few article titles showing through.
 *
 * The titles are the point. A folder called "Financials" tells a customer
 * nothing about whether their transfer question is inside it; "Billing Days ||
 * Transfer Cycle and Fees" tells them immediately — and often it *is* the
 * article they wanted, so the preview saves them the intermediate page
 * entirely.
 */
function FolderPanel({
  locale,
  categorySlug,
  folder,
}: {
  locale: Locale;
  categorySlug: string;
  folder: FolderSummary;
}) {
  const href = `/${locale}/c/${categorySlug}/${folder.slug}`;

  return (
    <Panel as="section" className="flex flex-col p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--kb-band-soft)] text-[var(--kb-band-ink)]">
          <FolderIcon size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-[var(--kb-heading)]">
            <Link href={href} className="underline-offset-4 hover:underline">
              {folder.name}
            </Link>
          </h2>
          <p className="mt-0.5 text-xs text-[var(--kb-muted)]">
            {articleCount(locale, folder.articleCount)}
          </p>
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-2.5 text-sm">
        {folder.preview.map((article) => (
          <li key={article.id}>
            <Link
              href={`/${locale}/a/${article.slug}`}
              className="flex items-start gap-2 text-[var(--kb-link)] underline-offset-4 hover:underline"
            >
              <DocumentIcon size={17} className="mt-0.5 shrink-0 text-[var(--kb-muted)]" />
              <span className="min-w-0">{article.title}</span>
            </Link>
          </li>
        ))}
      </ul>

      {folder.articleCount > folder.preview.length ? (
        <Link
          href={href}
          className="pt-4 text-sm font-medium text-[var(--kb-link)] underline-offset-4 hover:underline"
        >
          {t(locale, 'viewAll')} {formatCount(locale, folder.articleCount)}
        </Link>
      ) : null}
    </Panel>
  );
}
