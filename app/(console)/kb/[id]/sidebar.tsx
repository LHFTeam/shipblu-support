'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { RelativeTime } from '@/components/relative-time';
import { Badge, Button, ErrorText, Select } from '@/components/ui';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { useActionForm } from '@/components/use-action-form';
import { sentenceCase } from '@/lib/format';
import type { ArticleVersion, TranslationGroup, TranslationOption } from '@/lib/kb/admin';
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
  translations,
  translationCandidates,
  publicUrl,
  versions,
  stats,
}: {
  articleId: string;
  status: string;
  translations: TranslationGroup;
  translationCandidates: TranslationOption[];
  publicUrl: string | null;
  versions: ArticleVersion[];
  stats: { views: number; helpful: number; unhelpful: number };
}) {
  const [statusState, statusAction] = useActionState(setArticleStatus, INITIAL);
  const link = useActionForm(linkTranslation, INITIAL);

  // `total` counts the group without the role filter, so "not linked" is only
  // ever said when the group really is empty. Deriving this by filtering the
  // candidate list is what made the console claim an article had no translation
  // when it had one it could not show.
  const hidden = translations.total - translations.readable.length;
  const [restoreState, restoreAction] = useActionState(restoreVersion, INITIAL);
  const [deleteState, deleteAction] = useActionState(deleteArticle, INITIAL);

  return (
    <aside className="w-64 shrink-0">
      <section className="mb-5">
        <h2 className="mb-2 text-xs font-semibold text-(--color-text-secondary)">Status</h2>

        <div className="mb-2">
          <Badge tone={status === 'published' ? 'success' : 'neutral'}>
            {sentenceCase(status)}
          </Badge>
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
            className="mt-2 block truncate text-xs text-(--color-text-link) underline underline-offset-4 hover:text-(--color-text-link-hover)"
          >
            View on the help centre
          </a>
        ) : null}
      </section>

      <section className="mb-5 border-t border-(--color-border-subtle) pt-4">
        <h2 className="mb-2 text-xs font-semibold text-(--color-text-secondary)">Readers</h2>
        <dl className="flex flex-col gap-1 text-xs">
          <div className="flex justify-between">
            <dt className="text-(--color-text-secondary)">Views</dt>
            <dd>{stats.views}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-(--color-text-secondary)">Helpful</dt>
            <dd>{stats.helpful}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-(--color-text-secondary)">Not helpful</dt>
            <dd>{stats.unhelpful}</dd>
          </div>
        </dl>
      </section>

      <section className="mb-5 border-t border-(--color-border-subtle) pt-4">
        <h2 className="mb-2 text-xs font-semibold text-(--color-text-secondary)">Translations</h2>

        {translations.total === 0 ? (
          <p className="mb-2 text-xs text-(--color-text-tertiary)">
            Not linked to any other language. The help centre shows a language switcher only between
            articles that are linked.
          </p>
        ) : (
          <ul className="mb-2 flex flex-col gap-1 text-xs">
            {translations.readable.map((article) => (
              <li key={article.id} className="flex items-baseline gap-2">
                <Badge>{article.locale}</Badge>
                <Link
                  href={`/kb/${article.id}`}
                  className="min-w-0 flex-1 truncate text-(--color-text-link) underline underline-offset-2 hover:text-(--color-text-link-hover)"
                >
                  {article.title}
                </Link>
                {/*
                  A draft or archived translation is not on the help centre —
                  `translationsOf` applies the reader's visibility — so showing it
                  the same as a live one asserts a switcher that nobody sees.
                */}
                {article.status !== 'published' ? (
                  <span className="shrink-0 text-(--color-text-tertiary)">{article.status}</span>
                ) : null}
              </li>
            ))}
            {hidden > 0 ? (
              <li className="text-(--color-text-tertiary)">{hidden} more you cannot open</li>
            ) : null}
          </ul>
        )}

        {translationCandidates.length === 0 ? (
          <p className="text-xs text-(--color-text-tertiary)">
            No article in another language to link to yet.
          </p>
        ) : (
          <form key={link.key} {...link.form} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={articleId} />
            <label htmlFor="otherId" className="sr-only">
              Link this article to its translation
            </label>
            <Select id="otherId" name="otherId" defaultValue="" className="w-full text-xs">
              <option value="">Link to an article…</option>
              {translationCandidates.map((article) => (
                <option key={article.id} value={article.id}>
                  {article.locale} — {article.title}
                  {article.status === 'published' ? '' : ` (${article.status})`}
                </option>
              ))}
            </Select>
            <LinkButton />
            {/*
              Inside the form: it explains a consequence of using this control,
              so it made no sense on a page where the control is absent. The
              "left behind" half only applies once there is a group to leave.
            */}
            <p className="text-xs text-(--color-text-tertiary)">
              {translations.total > 0
                ? 'This article joins the one you pick, so the language it is linked to now is left behind.'
                : 'Pick the same article in the other language. The help centre will then offer a switcher between them.'}
            </p>
          </form>
        )}

        <ErrorText>{link.state.error}</ErrorText>
      </section>

      <section className="mb-5 border-t border-(--color-border-subtle) pt-4">
        <h2 className="mb-2 text-xs font-semibold text-(--color-text-secondary)">History</h2>

        {versions.length === 0 ? (
          <p className="text-xs text-(--color-text-tertiary)">No earlier versions.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {versions.map((version) => (
              <li key={version.id} className="flex items-center gap-2">
                <span className="text-(--color-text-secondary)">v{version.version}</span>
                <span className="min-w-0 flex-1 truncate">{version.editedBy ?? 'Unknown'}</span>
                <span className="text-(--color-text-tertiary)">
                  <RelativeTime at={version.createdAt} />
                </span>

                <form action={restoreAction}>
                  <input type="hidden" name="id" value={articleId} />
                  <input type="hidden" name="versionId" value={version.id} />
                  <Button type="submit" variant="ghost" size="sm">
                    Restore
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <ErrorText>{restoreState.error}</ErrorText>
      </section>

      <section className="border-t border-(--color-border-subtle) pt-4">
        <form action={deleteAction}>
          <input type="hidden" name="id" value={articleId} />
          {/* Two clicks rather than the browser's confirm(): deletion cascades to
              versions and feedback and cannot be undone from the console, and
              a native dialog is the one thing in the console that steals the
              page. The server still checks kb.publish. */}
          <ConfirmSubmit label="Delete article" confirmLabel="Really delete?" busy="Deleting…" />
        </form>
        <p className="mt-1 text-xs text-(--color-text-tertiary)">
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
    <Button
      type="submit"
      variant="secondary"
      disabled={pending}
      loading={pending}
      className="w-full"
    >
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
    <Button type="submit" variant={variant} disabled={pending} loading={pending} className="w-full">
      {pending ? busy : idle}
    </Button>
  );
}
