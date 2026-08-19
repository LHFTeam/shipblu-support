'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import type { FolderOption } from '@/lib/kb/admin';
import { saveArticle, type KbState } from './actions';

const INITIAL: KbState = { error: null };

export type EditorArticle = {
  id: string;
  title: string;
  slug: string;
  bodyHtml: string;
  locale: string;
  folderId: string;
  visibility: string;
  tags: string[];
  seo: { title?: string; description?: string };
};

/**
 * Article editor.
 *
 * Deliberately an HTML source field with a live preview rather than a
 * WYSIWYG. Three reasons: imported Freshdesk articles are already HTML and a
 * rich editor would rewrite them on first save, the output is sanitised
 * server-side anyway so the editor cannot be the security boundary, and a
 * WYSIWYG worth using is a large dependency to carry for a few dozen articles
 * a year. This can be swapped for one later without touching the storage
 * format, which is the point of keeping it HTML.
 */
export function ArticleEditor({
  article,
  folders,
}: {
  article: EditorArticle | null;
  folders: FolderOption[];
}) {
  const [state, action] = useActionState(saveArticle, INITIAL);
  const router = useRouter();

  // Re-reads the server components after a save, so the version list and the
  // status badge match what was just written.
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);

  const [locale, setLocale] = useState(article?.locale ?? 'en');
  const [body, setBody] = useState(article?.bodyHtml ?? '');
  const [showPreview, setShowPreview] = useState(true);

  // A folder belongs to a category, and a category has a locale. Offering
  // folders from the other language would let an author file an article
  // somewhere the public routes can never reach it — the server rejects that,
  // but the picker should not offer it in the first place.
  const available = folders.filter((folder) => folder.categoryLocale === locale);

  return (
    <form action={action} className="flex flex-col gap-4">
      {article ? <input type="hidden" name="id" value={article.id} /> : null}

      <div>
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" defaultValue={article?.title ?? ''} required autoFocus />
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="w-32">
          <Label htmlFor="locale">Language</Label>
          <Select
            id="locale"
            name="locale"
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
          >
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </Select>
        </div>

        <div className="min-w-56 flex-1">
          <Label htmlFor="folderId">Folder</Label>
          <Select id="folderId" name="folderId" defaultValue={article?.folderId ?? ''} required>
            <option value="" disabled>
              {available.length ? 'Choose a folder…' : 'No folders in this language yet'}
            </option>
            {available.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.categoryName} › {folder.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-44">
          <Label htmlFor="visibility">Visibility</Label>
          <Select id="visibility" name="visibility" defaultValue={article?.visibility ?? 'public'}>
            <option value="public">Public</option>
            <option value="agents_only">Agents only</option>
            <option value="logged_in">Signed-in customers</option>
          </Select>
        </div>
      </div>

      {/*
        Only 'public' articles are served today. Customers can sign in now, but
        the public queries do not yet take the viewer into account, so
        'logged_in' still evaluates to not-public. Saying so here stops someone
        marking an article 'logged_in' and expecting customers to see it.
      */}
      <p className="-mt-2 text-xs opacity-50">
        Only public articles appear on the help centre. Agents-only and signed-in articles are
        stored and searchable here, but are not served to customers yet — signed-in visibility is
        not wired to the portal sign-in.
      </p>

      <div>
        <div className="mb-1 flex items-center gap-3">
          <Label htmlFor="bodyHtml">Body (HTML)</Label>
          <button
            type="button"
            onClick={() => setShowPreview((value) => !value)}
            className="ms-auto text-xs opacity-60 hover:opacity-100"
          >
            {showPreview ? 'Hide preview' : 'Show preview'}
          </button>
        </div>

        <div className={showPreview ? 'grid gap-3 lg:grid-cols-2' : ''}>
          <Textarea
            id="bodyHtml"
            name="bodyHtml"
            rows={22}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="font-mono text-xs"
            dir="ltr"
          />

          {showPreview ? (
            <div
              dir={locale === 'ar' ? 'rtl' : 'ltr'}
              lang={locale}
              className="kb-article max-h-[34rem] overflow-y-auto rounded-md border border-[var(--border)] p-4 text-sm"
              // Preview only, and it renders the author's own unsaved draft in
              // their own browser — no other user's input reaches it. What gets
              // stored is sanitised server-side, which is the boundary that
              // matters.
              dangerouslySetInnerHTML={{ __html: body }}
            />
          ) : null}
        </div>
      </div>

      <details className="rounded-md border border-[var(--border)] p-3">
        <summary className="cursor-pointer text-sm font-medium">URL, tags and SEO</summary>

        <div className="mt-3 flex flex-col gap-3">
          <div>
            <Label htmlFor="slug">Slug</Label>
            <Input
              id="slug"
              name="slug"
              defaultValue={article?.slug ?? ''}
              placeholder="Left blank, generated from the title"
            />
            <p className="mt-1 text-xs opacity-50">
              Changing this changes the article&apos;s public URL. The old one stops working unless
              a redirect is added.
            </p>
          </div>

          <div>
            <Label htmlFor="tags">Tags</Label>
            <Input
              id="tags"
              name="tags"
              defaultValue={article?.tags.join(', ') ?? ''}
              placeholder="comma, separated"
            />
          </div>

          <div>
            <Label htmlFor="seoTitle">SEO title</Label>
            <Input id="seoTitle" name="seoTitle" defaultValue={article?.seo.title ?? ''} />
          </div>

          <div>
            <Label htmlFor="seoDescription">SEO description</Label>
            <Input
              id="seoDescription"
              name="seoDescription"
              defaultValue={article?.seo.description ?? ''}
            />
          </div>
        </div>
      </details>

      <ErrorText>{state.error}</ErrorText>

      <div className="flex items-center gap-3">
        {state.ok ? <span className="text-xs opacity-60">Saved.</span> : null}
        <SaveButton />
      </div>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="ms-auto">
      {pending ? 'Saving…' : 'Save'}
    </Button>
  );
}
