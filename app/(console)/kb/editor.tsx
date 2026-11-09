'use client';

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import type { AgentRole } from '@/lib/auth/permissions';
import type { FolderOption } from '@/lib/kb/admin';
import { FLOOR_LABELS, SELECTABLE_FLOORS } from '@/lib/kb/floors';
import {
  blockBoundaryAfter,
  insertBlock,
  KB_IMAGE_TYPES,
  labelRulesOut,
  NOT_A_PICTURE,
  pictureParagraph,
  pictureSizeRefusal,
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
  // Whether the author has been in the body at all, read when an upload
  // answers rather than in the render it started from: an upload begun from
  // the button before the author clicked into the body would otherwise put the
  // picture at the end however they moved the caret since. A box never focused
  // has no caret worth trusting (it reads 0), so its picture goes at the end.
  const bodyTouched = useRef(false);
  const picture = usePictureUpload();

  // A file released anywhere but the body (the preview beside it, a label, the
  // gutter) would otherwise open in place of the console, and the unsaved draft
  // with it. The body's own handlers below are what upload a picture.
  useEffect(() => {
    const hold = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', hold);
    window.addEventListener('drop', hold);
    return () => {
      window.removeEventListener('dragover', hold);
      window.removeEventListener('drop', hold);
    };
  }, []);

  /**
   * Puts an uploaded picture in where the caret is when the upload answers, at
   * the end of the block the caret is in: a caret mid-paragraph or inside a
   * tag would otherwise split it (`blockBoundaryAfter`).
   */
  function insertPicture(src: string) {
    const box = bodyRef.current;
    const touched = bodyTouched.current;
    setBody((current) => {
      const at = box && touched ? blockBoundaryAfter(current, box.selectionEnd) : current.length;
      const next = insertBlock(current, at, pictureParagraph(src));
      requestAnimationFrame(() => {
        box?.focus();
        box?.setSelectionRange(next.caret, next.caret);
      });
      return next.text;
    });
  }

  const addPictures = (files: File[]) => void picture.add(files, insertPicture);
  return (
    <form
      {...form}
      // A Save sent while a picture is still uploading posts the body without
      // it, and the picture lands after the page has moved on. The Save button
      // is disabled meanwhile, which also stops Enter in a field submitting (a
      // form whose default button is disabled is not submitted implicitly);
      // this refuses a submit that arrives any other way.
      onSubmit={(event) => {
        if (picture.uploading) {
          event.preventDefault();
          picture.refuse('A picture is still uploading. Save once it is in the body.');
          return;
        }
        picture.refuse(null);
        form.onSubmit(event);
      }}
      className="flex flex-col gap-4"
    >
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
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // Cleared, so choosing the same file again still fires a change.
              event.target.value = '';
              if (files.length > 0) addPictures(files);
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
            onChange={(event) => {
              setBody(event.target.value);
              picture.refuse(null);
            }}
            onFocus={() => {
              bodyTouched.current = true;
            }}
            onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
              // Word, Excel and Sheets put a rendered picture of what was copied
              // beside its text, and the text is what an author pasting from them
              // means. A screenshot or a copied image comes with no text.
              if (event.clipboardData.getData('text/plain').trim()) return;
              const files = Array.from(event.clipboardData.files);
              if (files.length === 0) return;
              event.preventDefault();
              addPictures(files);
            }}
            onDragOver={(event: DragEvent<HTMLTextAreaElement>) => {
              if (event.dataTransfer.types.includes('Files')) event.preventDefault();
            }}
            onDrop={(event: DragEvent<HTMLTextAreaElement>) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              addPictures(Array.from(event.dataTransfer.files));
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
        <SaveButton holding={picture.uploading} />
      </div>
    </form>
  );
}

/** `holding` while a picture uploads: see the form's `onSubmit`. */
function SaveButton({ holding }: { holding: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || holding} loading={pending} className="ms-auto">
      {pending ? 'Saving…' : 'Save'}
    </Button>
  );
}

/**
 * The editor's picture upload, from the button, a paste or a drop: each file in
 * turn, checked here for what the browser can tell and judged again by its bytes
 * on the server.
 *
 * Calls the action directly rather than through a form, so a refusal keeps the
 * draft and the answer lands in the editor's own state. `useActionForm`'s rule
 * about a thrown action is kept by hand: a dropped connection is a sentence,
 * not `global-error`. One batch at a time, and a second one asked for while it
 * runs is told to wait rather than dropped in silence.
 */
function usePictureUpload() {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function uploadOne(file: File): Promise<string | null> {
    const refusal = labelRulesOut(file.type) ? NOT_A_PICTURE : pictureSizeRefusal(file.size);
    if (refusal) {
      setError(refusal);
      return null;
    }
    const data = new FormData();
    data.set('picture', file);
    try {
      const answer = await uploadArticlePicture(data);
      if (answer.src) return answer.src;
      setError(answer.error ?? 'The picture could not be stored. Try again in a moment.');
    } catch {
      setError('The picture did not reach the server. Check the connection and try again.');
    }
    return null;
  }

  /** Uploads `files` one after another, handing each `src` to `insert` as it answers. */
  async function add(files: File[], insert: (src: string) => void) {
    if (busy.current) {
      setError('A picture is still uploading. Add the next one once it is in the body.');
      return;
    }
    const pictures = files.filter((file) => !labelRulesOut(file.type));
    if (pictures.length === 0) {
      setError(NOT_A_PICTURE);
      return;
    }

    busy.current = true;
    setUploading(true);
    setError(null);
    try {
      for (const file of pictures) {
        const src = await uploadOne(file);
        if (!src) return;
        insert(src);
      }
      if (pictures.length < files.length) {
        setError(
          'Only the pictures were added. The other files are not pictures an article can show.',
        );
      }
    } finally {
      busy.current = false;
      setUploading(false);
    }
  }

  return { uploading, error, add, refuse: setError };
}
