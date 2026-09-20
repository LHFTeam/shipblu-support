import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import {
  getArticleForEdit,
  listFolderOptionsForRole,
  listTranslationCandidates,
  listVersions,
  translationGroupOf,
} from '@/lib/kb/admin';
import { FLOOR_LABELS } from '@/lib/kb/floors';
import { direction } from '@/lib/kb/locale';
import { requestBaseUrl } from '@/lib/kb/site';
import { ArticleEditor } from '../editor';
import { ArticleSidebar } from './sidebar';

export const dynamic = 'force-dynamic';

/**
 * One article: read by anybody with `kb.view`, edited by anybody with
 * `kb.edit`.
 *
 * It used to require `kb.edit` outright, which is supervisor and up — so an
 * agent could see every article's title in the list, click one, and be bounced
 * to the inbox with `?error=forbidden`. That was survivable while the knowledge
 * base was entirely customer-facing content an agent read on the help centre
 * like everybody else. It stops being survivable the moment the internal
 * handbook is the thing being written: an article addressed to agents that no
 * agent can open is not published, it is filed.
 *
 * So the permission split moved to where it belongs. Reading is `kb.view`,
 * which the agent baseline carries; every write still goes through
 * `requirePermission('kb.edit')` or `'kb.publish'` inside the actions
 * themselves, so what an agent gets here is the article and nothing else — no
 * editor, no status controls, no version history. The role floor is applied
 * before any of that, by `getArticleForEdit`, which answers null for an article
 * above the reader.
 */
export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const agent = await requirePermission('kb.view');
  const mayEdit = can(agent, 'kb.edit');

  const { id } = await params;
  const article = await getArticleForEdit(id, agent.role);
  if (!article) notFound();

  // Built from the host this page is being served on rather than from
  // `publicBaseUrl()`. This link exists to be clicked by the person who just
  // wrote the article, and the published hostname is only the right answer once
  // it serves this app — until the domain cuts over it is a 404 wearing the
  // canonical address.
  //
  // `effectiveVisibility`, never the column: a `published`/`public` article
  // inside an `agents_only` folder is not on the help centre, so its URL is a
  // guaranteed 404 — the hole `folderVisibleTo` exists to close, offered here
  // as a link somebody will click.
  const publicUrl =
    article.status === 'published' && article.effectiveVisibility === 'public'
      ? `${requestBaseUrl(await headers())}/${article.locale}/a/${encodeURI(article.slug)}`
      : null;

  if (!mayEdit) {
    return (
      <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-y-auto p-6">
        <nav className="text-sm opacity-60">
          <Link href="/kb" className="hover:opacity-100">
            ← Knowledge base
          </Link>
        </nav>

        <header className="flex flex-wrap items-center gap-2">
          <Badge tone={article.status === 'published' ? 'open' : 'neutral'}>{article.status}</Badge>
          {article.effectiveMinRole ? (
            <Badge tone="warning">{FLOOR_LABELS[article.effectiveMinRole]}</Badge>
          ) : null}
          <Badge>{article.locale}</Badge>
        </header>

        {/*
          A reader gets the published article and nothing else.

          Widening this page to `kb.view` widened everything on it, not only the
          part that was being thought about: without this branch every agent
          could read the body of any draft. `agent-search.ts` states the rule
          for the composer — "no reviewer has agreed to its contents" — and it
          holds more strongly here, where the whole body is on screen rather
          than a search snippet. A notice rather than a 404, because the row is
          already in the list and a dead click is what this page was changed to
          stop.
        */}
        {article.status === 'published' ? (
          // `dir` and `lang` on the wrapper, once, exactly as the help centre's
          // shell does it — the formatting standard forbids either on an element
          // inside the body, so this is the only place an Arabic article is told
          // which way to run.
          <article
            dir={direction(article.locale === 'ar' ? 'ar' : 'en')}
            lang={article.locale}
            className="kb-article"
          >
            <h1 className="mb-4 text-2xl font-semibold">{article.title}</h1>
            {/*
              Stored HTML, sanitised on the way in by `sanitiseArticleHtml` and
              rendered here without a second pass — the same contract the public
              article page holds to, and for the same reason: re-sanitising on
              read would mask a gap on write.
            */}
            <div dangerouslySetInnerHTML={{ __html: article.bodyHtml }} />
          </article>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">{article.title}</h1>
            <p className="rounded-lg border border-[var(--border)] p-4 text-sm opacity-70">
              This article is {article.status === 'draft' ? 'still a draft' : 'archived'}. Nobody
              has approved what it says yet, so it is readable only by whoever can edit it. Ask a
              supervisor if you need it.
            </p>
          </>
        )}

        {publicUrl ? (
          <p className="text-sm opacity-60">
            Also on the help centre:{' '}
            <a href={publicUrl} className="underline underline-offset-4">
              {publicUrl}
            </a>
          </p>
        ) : null}
      </div>
    );
  }

  // Role-filtered, like `/kb/new`: the picker decides where this article can be
  // moved to, and a folder above the reader is not somewhere they can move it.
  const [folders, versions, translations, translationCandidates] = await Promise.all([
    listFolderOptionsForRole(agent.role),
    listVersions(id),
    translationGroupOf(id, article.translationGroupId, agent.role),
    listTranslationCandidates(id, article.locale, agent.role),
  ]);

  return (
    <div className="mx-auto flex h-full max-w-6xl gap-6 overflow-y-auto p-6">
      <div className="min-w-0 flex-1">
        <nav className="mb-4 text-sm opacity-60">
          <Link href="/kb" className="hover:opacity-100">
            ← Knowledge base
          </Link>
        </nav>

        <ArticleEditor
          article={{
            id: article.id,
            title: article.title,
            slug: article.slug,
            bodyHtml: article.bodyHtml,
            locale: article.locale,
            folderId: article.folderId,
            visibility: article.visibility,
            minRole: article.minRole,
            tags: article.tags,
            seo: article.seo,
          }}
          folders={folders}
        />
      </div>

      <ArticleSidebar
        articleId={article.id}
        status={article.status}
        translations={translations}
        translationCandidates={translationCandidates}
        publicUrl={publicUrl}
        versions={versions}
        stats={{
          views: article.viewCount,
          helpful: article.helpfulCount,
          unhelpful: article.unhelpfulCount,
        }}
      />
    </div>
  );
}
