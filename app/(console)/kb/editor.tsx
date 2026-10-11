'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import type { AgentRole } from '@/lib/auth/permissions';
import type { FolderOption } from '@/lib/kb/admin';
import { FLOOR_LABELS, SELECTABLE_FLOORS } from '@/lib/kb/floors';
import { useActionForm } from '@/components/use-action-form';
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
  minRole: AgentRole | null;
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
  const { state, key, form } = useActionForm(saveArticle, INITIAL);

  const [locale, setLocale] = useState(article?.locale ?? 'en');
  const [body, setBody] = useState(article?.bodyHtml ?? '');
  const [showPreview, setShowPreview] = useState(true);
  const [visibility, setVisibility] = useState(article?.visibility ?? 'public');
  const [folderId, setFolderId] = useState(article?.folderId ?? '');
  // Controlled, like the two beside it, because the field it renders is mounted
  // conditionally. Left uncontrolled, flipping Visibility to Public and back
  // reset the author's choice to the saved value with nothing on screen saying
  // so — and the action reads a missing field as "the form never offered one",
  // so the reset was invisible until the next person opened the article.
  const [minRole, setMinRole] = useState<string>(article?.minRole ?? '');

  // A folder belongs to a category, and a category has a locale. Offering
  // folders from the other language would let an author file an article
  // somewhere the public routes can never reach it — the server rejects that,
  // but the picker should not offer it in the first place.
  const available = folders.filter((folder) => folder.categoryLocale === locale);

  // The chosen folder decides two things the author needs to see: whether the
  // article is internal even when it says `public` — which is how all fifteen
  // of production's internal articles are shaped — and what floor it already
  // carries. A floor set here below the folder's does nothing; saying so beats
  // letting somebody choose "agents and up" and wonder why no agent sees it.
  const folder = available.find((option) => option.id === folderId);
  const internal = visibility === 'agents_only' || folder?.visibility === 'agents_only';

  return (
    <form {...form} className="flex flex-col gap-4">
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
          <Select
            id="folderId"
            name="folderId"
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
            required
          >
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
          <Select
            id="visibility"
            name="visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value)}
          >
            <option value="public">Public</option>
            <option value="agents_only">Agents only</option>
            <option value="logged_in">Signed-in customers</option>
          </Select>
        </div>

        {/*
          Only for internal articles, and it disappears rather than greying out.
          A floor is meaningless on anything a customer can open — the read rule
          drops it — so a control offering one there would be a promise the
          product does not keep.
        */}
        {internal ? (
          <div className="w-52">
            <Label htmlFor="minRole">Who on the team</Label>
            <Select
              id="minRole"
              name="minRole"
              value={minRole}
              onChange={(event) => setMinRole(event.target.value)}
            >
              {/*
                `SELECTABLE_FLOORS`, not every role: "Agents and up" stores a
                value every read model reports as no floor, so it would sit
                beside "Everyone on the team" doing the same thing.
              */}
              <option value="">Everyone on the team</option>
              {SELECTABLE_FLOORS.map((role) => (
                <option key={role} value={role}>
                  {FLOOR_LABELS[role]}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {internal ? (
        <p className="-mt-2 text-xs opacity-50">
          This article is internal
          {visibility === 'agents_only' ? '' : `, because ${folder?.name} is`}. No customer can
          reach it on the help centre, signed in or not, and it cannot be linked into a reply.
          {folder?.minRole
            ? ` ${folder.name} is already limited to ${FLOOR_LABELS[folder.minRole].toLowerCase()}; a lower setting here does not widen that.`
            : ''}
        </p>
      ) : null}

      {/*
        'logged_in' is served for real now: the public queries take the reader's
        portal session into account. Two things still need saying, because both
        would otherwise be discovered by an editor wondering why a page looks
        wrong — a signed-in article is deliberately absent from the sitemap, and
        the folder gates the article rather than the other way round.
      */}
      <p className="-mt-2 text-xs opacity-50">
        Public articles are open to everyone. Signed-in articles appear only once a customer has
        signed in to the portal, and are kept out of the sitemap and the chat widget, so search
        engines never index them. Agents-only articles are never served on the help centre at all. A
        folder&rsquo;s own visibility wins: a public article in a signed-in folder needs a sign-in.
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
              // Remounted on each save with the slug the save stored, taken
              // from the action's answer. A slug left blank is generated by
              // the server, and a box still blank afterwards would send blank
              // again and regenerate it from the next title, moving the
              // article's URL. React's reset used to refill it from the
              // revalidated page; `useActionForm` no longer resets, and the
              // answer arrives in the same commit as the key, which the
              // revalidated page is not promised to.
              key={key}
              id="slug"
              name="slug"
              defaultValue={state.slug ?? article?.slug ?? ''}
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
