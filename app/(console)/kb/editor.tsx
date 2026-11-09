'use client';

import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import type { AgentRole } from '@/lib/auth/permissions';
import type { FolderOption } from '@/lib/kb/admin';
import { FLOOR_LABELS, SELECTABLE_FLOORS } from '@/lib/kb/floors';
import {
  insertBlock,
  KB_IMAGE_MAX_BYTES,
  KB_IMAGE_TYPES,
  pictureParagraph,
} from '@/lib/kb/image-src';
import { useActionForm } from '@/components/use-action-form';
import { saveArticle, uploadArticlePicture, type KbState } from './actions';

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

  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Whether the author has been in the body at all. A box never focused has
  // no caret worth trusting (it reads 0), so a picture goes at the end.
  const [bodyFocused, setBodyFocused] = useState(false);
  const picture = usePictureUpload();

  async function addPicture(file: File) {
    const src = await picture.upload(file);
    if (!src) return;
    // Where the caret is when the upload answers, not where it was when it
    // started: the author may have kept typing.
    const box = bodyRef.current;
    setBody((current) => {
      const start = box && bodyFocused ? box.selectionStart : current.length;
      const end = box && bodyFocused ? box.selectionEnd : current.length;
      const next = insertBlock(current, start, end, pictureParagraph(src));
      requestAnimationFrame(() => {
        box?.focus();
        box?.setSelectionRange(next.caret, next.caret);
      });
      return next.text;
    });
  }

  /** The first picture among `files`, ignoring anything else carried with it. */
  const firstPicture = (files: FileList) =>
    Array.from(files).find((file) => file.type.startsWith('image/'));

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
        <p className="-mt-2 text-xs text-(--color-text-tertiary)">
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
      <p className="-mt-2 text-xs text-(--color-text-tertiary)">
        Public articles are open to everyone. Signed-in articles appear only once a customer has
        signed in to the portal, and are kept out of the sitemap and the chat widget, so search
        engines never index them. Agents-only articles are never served on the help centre at all. A
        folder&rsquo;s own visibility wins: a public article in a signed-in folder needs a sign-in.
      </p>

      <div>
        <div className="mb-1 flex items-center gap-3">
          <Label htmlFor="bodyHtml">Body (HTML)</Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={picture.uploading}
            loading={picture.uploading}
            className="ms-auto"
          >
            {picture.uploading ? 'Uploading picture…' : 'Insert picture'}
          </Button>
          {/*
            No `name`, so the article's own Save never posts it: the picture
            goes up on its own, through `uploadArticlePicture`, the moment it is
            chosen. `hidden` rather than `sr-only`, which is absolutely
            positioned and escapes an unpositioned pane (§6.81); the button
            above is how anybody reaches it.
          */}
          <input
            ref={fileRef}
            type="file"
            accept={Object.keys(KB_IMAGE_TYPES).join(',')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so choosing the same file again still fires a change.
              event.target.value = '';
              if (file) void addPicture(file);
            }}
            className="hidden"
            tabIndex={-1}
            aria-hidden
          />
          <Button variant="ghost" size="sm" onClick={() => setShowPreview((value) => !value)}>
            {showPreview ? 'Hide preview' : 'Show preview'}
          </Button>
        </div>

        <ErrorText>{picture.error}</ErrorText>

        <div className={showPreview ? 'grid gap-3 lg:grid-cols-2' : ''}>
          <Textarea
            ref={bodyRef}
            id="bodyHtml"
            name="bodyHtml"
            rows={22}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onFocus={() => setBodyFocused(true)}
            onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
              const file = firstPicture(event.clipboardData.files);
              if (!file) return;
              event.preventDefault();
              if (!picture.uploading) void addPicture(file);
            }}
            // Without this a file dropped on the box makes the browser open it
            // in place of the console, and the unsaved draft goes with the page.
            onDragOver={(event: DragEvent<HTMLTextAreaElement>) => {
              if (event.dataTransfer.types.includes('Files')) event.preventDefault();
            }}
            onDrop={(event: DragEvent<HTMLTextAreaElement>) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              const file = firstPicture(event.dataTransfer.files);
              if (!file) picture.refuse(NOT_A_PICTURE);
              else if (!picture.uploading) void addPicture(file);
            }}
            className="font-mono text-xs"
            dir="ltr"
          />

          {showPreview ? (
            <div
              dir={locale === 'ar' ? 'rtl' : 'ltr'}
              lang={locale}
              className="kb-article app-scroll relative max-h-[34rem] overflow-y-auto rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) p-4 text-sm"
              // Preview only, and it renders the author's own unsaved draft in
              // their own browser — no other user's input reaches it. What gets
              // stored is sanitised server-side, which is the boundary that
              // matters.
              dangerouslySetInnerHTML={{ __html: body }}
            />
          ) : null}
        </div>
      </div>

      <p className="-mt-2 text-xs text-(--color-text-tertiary)">
        Paste a screenshot into the body, drop a picture on it, or use Insert picture: it is stored
        here and put in where the cursor is. Say what it shows in its <code>alt</code>, which a
        screen reader reads aloud.
      </p>

      <details className="rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) p-3">
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
            <p className="mt-1 text-xs text-(--color-text-tertiary)">
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
        {state.ok ? (
          <span className="text-xs text-(--color-feedback-success-fg)">Saved.</span>
        ) : null}
        <SaveButton />
      </div>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} loading={pending} className="ms-auto">
      {pending ? 'Saving…' : 'Save'}
    </Button>
  );
}

const NOT_A_PICTURE = 'Only a PNG, JPEG, GIF or WebP picture can go in an article.';

/**
 * The editor's picture upload: one file at a time, from the button, a paste or
 * a drop, checked here for what the browser can tell and judged again by its
 * bytes on the server. Answers the `src` to insert, or null with `error` set.
 *
 * Calls the action directly rather than through a form, so a refusal keeps the
 * draft and the answer lands in the editor's own state. `useActionForm`'s rule
 * about a thrown action is kept by hand: a dropped connection is a sentence,
 * not `global-error`.
 */
function usePictureUpload() {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File): Promise<string | null> {
    // The browser's own label, which the server does not trust; it only saves
    // a round trip for a file that is plainly not a picture an article can show.
    if (!(file.type in KB_IMAGE_TYPES)) {
      setError(NOT_A_PICTURE);
      return null;
    }
    if (file.size > KB_IMAGE_MAX_BYTES) {
      const megabytes = (file.size / (1024 * 1024)).toFixed(1);
      setError(`That picture is ${megabytes} MB. A picture can be at most 10 MB.`);
      return null;
    }

    setUploading(true);
    setError(null);
    const data = new FormData();
    data.set('picture', file);
    try {
      const answer = await uploadArticlePicture(data);
      if (answer.error === undefined) return answer.src;
      setError(answer.error);
    } catch {
      setError('The picture did not reach the server. Check the connection and try again.');
    } finally {
      setUploading(false);
    }
    return null;
  }

  return { uploading, error, upload, refuse: setError };
}
