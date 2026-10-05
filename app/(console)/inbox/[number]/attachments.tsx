'use client';

import { type MouseEvent, useEffect, useId, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { isPreviewableImage } from '@/lib/attachments/preview';
import { formatBytes } from '@/lib/format';

type Attachment = { id: string; filename: string; contentType: string; sizeBytes: number };

const fileUrl = (file: Attachment) => `/api/attachments/${file.id}`;

/**
 * The files on one message: a row of chips, where a picture opens under the row
 * instead of in a new tab.
 *
 * In place rather than in a lightbox. This codebase has no modals (see
 * `ShipmentsField`), and the timeline's order is its information: the
 * photograph of a crushed box belongs beside the sentence complaining about it,
 * not in a layer over the whole ticket. Anything that is not a picture is left
 * as it was, because a PDF or a spreadsheet has nothing to show in a bubble.
 *
 * A picture's chip is still a link to the file, and only a plain click is taken
 * over. Every chip used to be one, and a Cmd-click to open five photos in
 * background tabs, a middle-click, "Copy link address" and a long-press to
 * download are all things a link does that a `<button>` would quietly take away.
 *
 * Nothing is fetched until it is clicked. Every picture is a signed URL minted
 * per request by `/api/attachments/[id]`, so an eager thumbnail would be a
 * Storage round trip per image each time a ticket opened — and every photo on a
 * long WhatsApp thread downloaded to an agent's phone whether or not anybody
 * looked at it. A preview stays mounted once opened, so hiding and showing it
 * again costs nothing. Its URL expired long ago by then, and whether a fresh
 * `<img>` would be answered from memory or mint another is the browser's
 * choice — the HTML spec leaves that cache optional — so this does not ask.
 *
 * `compact` is the side conversation card's density for the chip row, which
 * that card has always drawn a step smaller. An opened picture is the same size
 * at both, because the picture is what the agent opened it to read.
 */
export function AttachmentList({
  files,
  compact = false,
}: {
  files: Attachment[];
  compact?: boolean;
}) {
  const baseId = useId();
  // A key exists once a preview has been opened, which is also when it mounts;
  // its value is whether it is showing now.
  const [previews, setPreviews] = useState<Record<string, boolean>>({});

  if (files.length === 0) return null;

  const previewId = (file: Attachment) => `${baseId}-${file.id}`;
  const opened = files.filter((file) => previews[file.id] !== undefined);

  const toggle = (event: MouseEvent<HTMLAnchorElement>, file: Attachment) => {
    // A modified click means what it means on any link — a background tab, a
    // new window, a download — so it is left to the browser. Enter on a
    // focused link arrives here as a plain click, so the keyboard toggles too.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    setPreviews((current) => ({ ...current, [file.id]: !current[file.id] }));
  };

  return (
    <>
      <ul className={compact ? 'mt-1.5 flex flex-wrap gap-1.5' : 'mt-2 flex flex-wrap gap-2'}>
        {files.map((file) => (
          <li
            key={file.id}
            className={
              compact
                ? 'rounded border border-[var(--border)] px-1.5 py-0.5 text-xs'
                : 'rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs'
            }
          >
            {isPreviewableImage(file.contentType) ? (
              <a
                href={fileUrl(file)}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => toggle(event, file)}
                aria-expanded={previews[file.id] === true}
                // Only once the preview exists: before the first click there
                // is nothing in the document for it to name.
                aria-controls={previews[file.id] === undefined ? undefined : previewId(file)}
                className="inline-flex items-center gap-0.5 hover:underline"
              >
                {file.filename}
                {previews[file.id] === true ? (
                  <ChevronUpIcon size={14} />
                ) : (
                  <ChevronDownIcon size={14} />
                )}
              </a>
            ) : (
              <a href={fileUrl(file)} target="_blank" rel="noreferrer" className="hover:underline">
                {file.filename}
              </a>
            )}
            <span className={compact ? 'ms-1 opacity-60' : 'ms-1.5 text-[var(--muted-foreground)]'}>
              {formatBytes(file.sizeBytes)}
            </span>
          </li>
        ))}
      </ul>

      {opened.length > 0 ? (
        // Hidden rather than unmounted once every preview is closed, for the
        // same reason each preview is: unmounting would throw the pictures
        // away. Hidden at all because its margin would otherwise stay behind
        // as a strip of empty bubble under the chips.
        <div
          hidden={!opened.some((file) => previews[file.id] === true)}
          className="mt-2 flex flex-col items-start gap-2"
        >
          {opened.map((file) => (
            <ImagePreview
              key={file.id}
              id={previewId(file)}
              file={file}
              hidden={previews[file.id] !== true}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * One picture, linked to the original for when the detail matters — the
 * tracking number on a photographed label is often only legible full size.
 *
 * A picture that will not load says so and keeps the link, rather than leaving
 * a broken-image box: the bytes may be fine and only this browser unable to
 * decode them, or the session may have lapsed since the page was drawn, and in
 * both cases the file is still one click away. "Try again" draws a new `<img>`,
 * which asks the route again: a failed load is never in the browser's memory to
 * be answered from, so a Storage timeout a moment ago does not decide what the
 * agent sees now.
 */
function ImagePreview({ id, file, hidden }: { id: string; file: Attachment; hidden: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const figure = useRef<HTMLElement>(null);

  // Keyed on the two things a person changes. A live update re-renders this
  // with neither changed, so new activity on the ticket never moves the pane.
  useEffect(() => {
    if (!hidden && state !== 'loading' && figure.current) revealInPane(figure.current);
  }, [hidden, state]);

  return (
    <figure ref={figure} id={id} hidden={hidden} className="max-w-full">
      {state === 'failed' ? null : (
        <a
          href={fileUrl(file)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${file.filename} full size in a new tab`}
          className="block"
        >
          {/*
            Not next/image, for the reason `components/avatar.tsx` gives: the
            source is a redirect to a signed URL on a host that changes per
            request, which the optimiser cannot cache and would only add a hop to.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={fileUrl(file)}
            alt={file.filename}
            decoding="async"
            onLoad={() => setState('loaded')}
            onError={() => setState('failed')}
            className="block max-h-96 max-w-full cursor-zoom-in rounded-md border border-[var(--border)] bg-[var(--surface)]"
          />
        </a>
      )}
      <p className="text-xs text-[var(--muted-foreground)]">
        {/* A live region, so a screen reader hears what the chip's "expanded"
            does not say: that the picture never arrived, and what to do next.
            Mounted for the figure's life — a region that appears already
            holding its text is not announced. */}
        <span role="status">
          {state === 'loading'
            ? 'Loading picture…'
            : state === 'failed'
              ? `${file.filename} could not be shown here.`
              : null}
        </span>
        {state === 'failed' ? (
          <>
            {' '}
            <button type="button" onClick={() => setState('loading')} className="underline">
              Try again
            </button>
            {' · '}
            <a href={fileUrl(file)} target="_blank" rel="noreferrer" className="underline">
              Open the file
            </a>
          </>
        ) : null}
      </p>
    </figure>
  );
}

/**
 * Brings a picture that has just opened into view, inside the pane that
 * scrolls it and nothing else.
 *
 * A chip on the last message opens its picture below the fold — on a phone with
 * the composer up the pane is a couple of hundred pixels — so without this the
 * tap looks as though it did nothing.
 *
 * Not `scrollIntoView`, which scrolls every scrollable ancestor. The console
 * shell is `h-dvh overflow-hidden`, which nobody can scroll by hand but script
 * can, so a picture taller than the pane would shift the whole console with no
 * way to put it back. So: the nearest ancestor that scrolls by hand, and only
 * that one.
 *
 * Only when the top of the picture is already on screen, which is the agent
 * still looking where they tapped. One who has scrolled away while it loaded
 * is reading something else, and pulling them back would take their place.
 * And never so far that the top leaves the pane, so the chip they pressed is
 * the last thing to go.
 */
function revealInPane(element: HTMLElement) {
  let pane = element.parentElement;
  while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) {
    pane = pane.parentElement;
  }
  if (!pane) return;

  const box = element.getBoundingClientRect();
  const view = pane.getBoundingClientRect();
  const topOnScreen = box.top >= view.top && box.top < view.bottom;
  if (!topOnScreen || box.bottom <= view.bottom) return;

  pane.scrollBy({
    top: Math.min(box.bottom - view.bottom, box.top - view.top),
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}
