'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorText, Select } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import type { ArticleVersion, TranslationOption } from '@/lib/kb/admin';
import {
  deleteArticle,
  linkTranslation,
  restoreVersion,
  setArticleStatus,
  type KbState,
} from '../actions';

const INITIAL: KbState = { error: null };

export function ArticleSidebar({
  articleId,
  status,
  locale,
  translationGroupId,
  translationOptions,
  publicUrl,
  versions,
  stats,
}: {
  articleId: string;
  status: string;
  locale: string;
  translationGroupId: string;
  translationOptions: TranslationOption[];
  publicUrl: string | null;
  versions: ArticleVersion[];
  stats: { views: number; helpful: number; unhelpful: number };
}) {
  const [statusState, statusAction] = useActionState(setArticleStatus, INITIAL);
  const [linkState, linkAction] = useActionState(linkTranslation, INITIAL);

  // The same rows read twice, which is why they arrive in one list: anything
  // already sharing this article's group is a translation of it, and anything
  // else in another language is something it could become one of. A same-locale
  // article is never offered — the action refuses it, and an option that always
  // errors is worse than no option.
  const linked = translationOptions.filter((a) => a.translationGroupId === translationGroupId);
  const candidates = translationOptions.filter(
    (a) => a.translationGroupId !== translationGroupId && a.locale !== locale,
  );
  const [restoreState, restoreAction] = useActionState(restoreVersion, INITIAL);
  const [deleteState, deleteAction] = useActionState(deleteArticle, INITIAL);

  return (
    <aside className="w-64 shrink-0">
      <section className="mb-5">
        <h2 className="mb-2 text-xs font-medium opacity-60">Status</h2>

        <div className="mb-2">
          <Badge tone={status === 'published' ? 'open' : 'neutral'}>{status}</Badge>
        </div>

        <div className="flex flex-col gap-2">
          {status !== 'published' ? (
            <form action={statusAction}>
              <input type="hidden" name="id" value={articleId} />
              <input type="hidden" name="status" value="published" />
              <StatusButton idle="Publish" busy="Publishing…" />
            </form>
          ) : (
            <form action={statusAction}>
              <input type="hidden" name="id" value={articleId} />
              <input type="hidden" name="status" value="draft" />
              <StatusButton idle="Unpublish" busy="Unpublishing…" variant="secondary" />
            </form>
          )}

          {status !== 'archived' ? (
            <form action={statusAction}>
              <input type="hidden" name="id" value={articleId} />
              <input type="hidden" name="status" value="archived" />
              <StatusButton idle="Archive" busy="Archiving…" variant="secondary" />
            </form>
          ) : null}
        </div>

        <ErrorText>{statusState.error}</ErrorText>

        {publicUrl ? (
          <a
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block truncate text-xs underline underline-offset-4 opacity-60 hover:opacity-100"
          >
            View on the help centre
          </a>
        ) : null}
      </section>

      <section className="mb-5 border-t border-[var(--border)] pt-4">
        <h2 className="mb-2 text-xs font-medium opacity-60">Readers</h2>
        <dl className="flex flex-col gap-1 text-xs">
          <div className="flex justify-between">
            <dt className="opacity-60">Views</dt>
            <dd>{stats.views}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="opacity-60">Helpful</dt>
            <dd>{stats.helpful}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="opacity-60">Not helpful</dt>
            <dd>{stats.unhelpful}</dd>
          </div>
        </dl>
      </section>

      <section className="mb-5 border-t border-[var(--border)] pt-4">
        <h2 className="mb-2 text-xs font-medium opacity-60">Translations</h2>

        {linked.length === 0 ? (
          <p className="mb-2 text-xs opacity-50">
            Not linked to any other language. The help centre shows a language switcher only between
            articles that are linked.
          </p>
        ) : (
          <ul className="mb-2 flex flex-col gap-1 text-xs">
            {linked.map((article) => (
              <li key={article.id} className="flex items-baseline gap-2">
                <Badge>{article.locale}</Badge>
                <Link
                  href={`/kb/${article.id}`}
                  className="min-w-0 flex-1 truncate underline underline-offset-2 opacity-70 hover:opacity-100"
                >
                  {article.title}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {candidates.length === 0 ? (
          <p className="text-xs opacity-50">No article in another language to link to yet.</p>
        ) : (
          <form action={linkAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={articleId} />
            <label htmlFor="otherId" className="sr-only">
              Link this article to its translation
            </label>
            <Select id="otherId" name="otherId" defaultValue="" className="w-full text-xs">
              <option value="">Link to an article…</option>
              {candidates.map((article) => (
                <option key={article.id} value={article.id}>
                  {article.locale} — {article.title}
                  {article.status === 'published' ? '' : ` (${article.status})`}
                </option>
              ))}
            </Select>
            <LinkButton />
          </form>
        )}

        <p className="mt-1 text-xs opacity-50">
          This article joins the one you pick, so any language it was linked to before is left
          behind.
        </p>

        <ErrorText>{linkState.error}</ErrorText>
      </section>

      <section className="mb-5 border-t border-[var(--border)] pt-4">
        <h2 className="mb-2 text-xs font-medium opacity-60">History</h2>

        {versions.length === 0 ? (
          <p className="text-xs opacity-50">No earlier versions.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {versions.map((version) => (
              <li key={version.id} className="flex items-baseline gap-2">
                <span className="opacity-60">v{version.version}</span>
                <span className="min-w-0 flex-1 truncate">{version.editedBy ?? 'Unknown'}</span>
                <span className="opacity-50">{formatRelative(version.createdAt)}</span>

                <form action={restoreAction}>
                  <input type="hidden" name="id" value={articleId} />
                  <input type="hidden" name="versionId" value={version.id} />
                  <button
                    type="submit"
                    className="underline underline-offset-2 opacity-60 hover:opacity-100"
                  >
                    restore
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <ErrorText>{restoreState.error}</ErrorText>
      </section>

      <section className="border-t border-[var(--border)] pt-4">
        <form action={deleteAction}>
          <input type="hidden" name="id" value={articleId} />
          <DeleteButton />
        </form>
        <p className="mt-1 text-xs opacity-50">
          Deleting removes the article and its history. Archive instead if the URL should keep
          working for anyone who has it bookmarked.
        </p>
        <ErrorText>{deleteState.error}</ErrorText>
      </section>
    </aside>
  );
}

function LinkButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" disabled={pending} className="w-full">
      {pending ? 'Linking…' : 'Link translation'}
    </Button>
  );
}

function StatusButton({
  idle,
  busy,
  variant = 'primary',
}: {
  idle: string;
  busy: string;
  variant?: 'primary' | 'secondary';
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} className="w-full">
      {pending ? busy : idle}
    </Button>
  );
}

function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant="danger"
      disabled={pending}
      className="w-full"
      // Deletion cascades to versions and feedback and cannot be undone from
      // the console, so it asks first. The server still checks kb.publish.
      onClick={(event) => {
        if (!confirm('Delete this article and its history? This cannot be undone.')) {
          event.preventDefault();
        }
      }}
    >
      {pending ? 'Deleting…' : 'Delete article'}
    </Button>
  );
}
