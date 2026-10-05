'use client';

import { type MouseEvent, useEffect, useId, useReducer, useRef } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { isPreviewableImage } from '@/lib/attachments/preview';
import { initialPreviewState, type Load, loadOf, previewReducer } from '@/lib/attachments/previews';
import { formatBytes } from '@/lib/format';

type Attachment = { id: string; filename: string; contentType: string; sizeBytes: number };

/** What was pressed to ask for a picture, which is where the agent is looking. */
type Pressed = 'chip' | 'figure';

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
 * The price is the one key a link does not answer: Space scrolls the pane, as it
 * always did on these chips, and only Enter opens the picture.
 *
 * Nothing is fetched until it is clicked. Every picture is a signed URL minted
 * per request by `/api/attachments/[id]`, so an eager thumbnail would be a
 * Storage round trip per image each time a ticket opened — and every photo on a
 * long WhatsApp thread downloaded to an agent's phone whether or not anybody
 * looked at it. A preview stays mounted once opened, so hiding and showing it
 * again costs nothing. A fresh `<img>` would ask the route again, which mints
 * another URL, unless the browser answered it from its list of available
 * images — which the HTML spec lets it empty at any time — so this does not ask.
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
  const [state, dispatch] = useReducer(previewReducer, initialPreviewState);
  const chips = useRef(new Map<string, HTMLElement>());
  const figures = useRef(new Map<string, HTMLElement>());
  /*
    Pictures waiting to be brought into view, each with what was pressed to ask
    for it.

    Written only by the agent's clicks, so a live update re-rendering the list
    with a picture open never moves the pane. An entry is spent by its reveal,
    or dropped when its preview turns out closed. One per picture, so closing
    one picture to make room does not cancel the reveal of another still
    loading.
  */
  const pending = useRef(new Map<string, Pressed>());

  useEffect(() => {
    for (const [id, pressed] of pending.current) {
      if (state.showing[id] !== true) {
        pending.current.delete(id);
        continue;
      }
      if (loadOf(state, id) === 'loading') continue;
      pending.current.delete(id);

      const figure = figures.current.get(id);
      const anchor = pressed === 'chip' ? chips.current.get(id) : figure;
      if (figure && anchor) revealInPane(figure, anchor);
    }
  }, [state]);

  if (files.length === 0) return null;

  const previewId = (file: Attachment) => `${baseId}-${file.id}`;
  const opened = files.filter((file) => state.showing[file.id] !== undefined);

  const toggle = (event: MouseEvent<HTMLAnchorElement>, file: Attachment) => {
    // A modified click means what it means on any link — a background tab, a
    // new window, a download — so it is left to the browser. Enter on a
    // focused link arrives here as a plain click.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    pending.current.set(file.id, 'chip');
    dispatch({ type: 'toggle', file });
  };

  const retry = (file: Attachment) => {
    // The button pressed is about to unmount with the failure line, which
    // would drop focus to <body> — and a screen reader whose focused node
    // vanishes loses its place in the ticket. The figure stays.
    figures.current.get(file.id)?.focus({ preventScroll: true });
    // The figure, not the chip: the agent was looking at "Try again", which may
    // be a whole picture's height below the chip.
    pending.current.set(file.id, 'figure');
    dispatch({ type: 'retry', file });
  };

  const settle = (file: Attachment, load: 'loaded' | 'failed') => {
    // The same rescue as `retry`, for the other thing a failure unmounts: the
    // picture's own link, which Tab reaches while it is still loading — and
    // reaches first after "Try again", so a second failure would otherwise
    // drop focus exactly where the first one was caught.
    const figure = figures.current.get(file.id);
    if (load === 'failed' && figure?.contains(document.activeElement)) {
      figure.focus({ preventScroll: true });
    }
    dispatch({ type: 'settle', file, load });
  };

  return (
    // Positioned for the live region's sake. `sr-only` is `position: absolute`,
    // and nothing above the timeline is positioned, so without this its box is
    // placed against the document — past every `overflow-hidden` up to the shell
    // — and stretches the page under the console by however far down the
    // thread this message is. Scrolling past the end of the timeline then
    // scrolled the whole console off the screen.
    <div className="relative">
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
                ref={(node) => {
                  if (node) chips.current.set(file.id, node);
                  else chips.current.delete(file.id);
                }}
                href={fileUrl(file)}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => toggle(event, file)}
                aria-expanded={state.showing[file.id] === true}
                // Only once the preview exists: before the first click there
                // is nothing in the document for it to name.
                aria-controls={state.showing[file.id] === undefined ? undefined : previewId(file)}
                className="inline-flex items-center gap-0.5 hover:underline"
              >
                {file.filename}
                {state.showing[file.id] === true ? (
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

      {/*
        One live region for the list, there from the first render. A change is
        only announced in a region the screen reader already knew was there, so
        one mounted with each figure missed the very failure it existed for — a
        401 can land within a frame or two of the click.

        Failures only, and `previewReducer` says when. Loading is visible text
        and stays out of it: "Loading picture" read out after "expanded", for a
        photo that arrived in a tenth of a second, is noise between the agent
        and the ticket.
      */}
      {files.some((file) => isPreviewableImage(file.contentType)) ? (
        <span role="status" className="sr-only">
          {state.notice ? <span key={state.notice.seq}>{state.notice.text}</span> : null}
        </span>
      ) : null}

      {opened.length > 0 ? (
        // Hidden rather than unmounted once every preview is closed, for the
        // same reason each preview is: unmounting would throw the pictures
        // away. Hidden at all because its margin would otherwise stay behind
        // as a strip of empty bubble under the chips.
        <div
          hidden={!opened.some((file) => state.showing[file.id] === true)}
          className="mt-2 flex flex-col items-start gap-2"
        >
          {opened.map((file) => (
            <ImagePreview
              key={file.id}
              id={previewId(file)}
              file={file}
              hidden={state.showing[file.id] !== true}
              load={loadOf(state, file.id)}
              figureRef={(node) => {
                if (node) figures.current.set(file.id, node);
                else figures.current.delete(file.id);
              }}
              onSettle={(load) => settle(file, load)}
              onRetry={() => retry(file)}
            />
          ))}
        </div>
      ) : null}
    </div>
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
 * which asks the route again: a failed load is never in the browser's list of
 * available images to be answered from, so a Storage timeout a moment ago does
 * not decide what the agent sees now.
 *
 * The figure takes focus (`tabIndex={-1}`, so never by Tab) only because
 * "Try again" hands focus to it before unmounting — see `retry`.
 */
function ImagePreview({
  id,
  file,
  hidden,
  load,
  figureRef,
  onSettle,
  onRetry,
}: {
  id: string;
  file: Attachment;
  hidden: boolean;
  load: Load;
  figureRef: (node: HTMLElement | null) => void;
  onSettle: (load: 'loaded' | 'failed') => void;
  onRetry: () => void;
}) {
  const failureId = `${id}-failure`;

  return (
    <figure ref={figureRef} id={id} hidden={hidden} tabIndex={-1} className="max-w-full">
      {load === 'failed' ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          <span id={failureId}>{file.filename} could not be shown here.</span>{' '}
          {/* Described by the sentence rather than renamed, so the name stays
              the label on screen for voice control, and each control says which
              picture it is about when it takes focus. A list of names alone —
              a rotor, an elements list — still shows two "Try again"s when two
              pictures fail; a name that differed from the label would be the
              worse trade. */}
          <button
            type="button"
            onClick={onRetry}
            aria-describedby={failureId}
            className="underline"
          >
            Try again
          </button>
          {' · '}
          <a
            href={fileUrl(file)}
            target="_blank"
            rel="noreferrer"
            aria-describedby={failureId}
            className="underline"
          >
            Open the file
          </a>
        </p>
      ) : (
        <>
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
              onLoad={() => onSettle('loaded')}
              onError={() => onSettle('failed')}
              className="block max-h-96 max-w-full cursor-zoom-in rounded-md border border-[var(--border)] bg-[var(--surface)]"
            />
          </a>
          {load === 'loading' ? (
            <p className="text-xs text-[var(--muted-foreground)]">Loading picture…</p>
          ) : null}
        </>
      )}
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
 * way to put it back. So: the nearest ancestor that is set to scroll and has
 * something to scroll, and only that one.
 *
 * Only while what was pressed — the chip, or the figure that held "Try again" —
 * is still at least partly on screen, which is the agent still looking where
 * they tapped. One who has scrolled away while it loaded is reading something
 * else, and pulling them back would take their place. What was pressed rather
 * than the picture, because a picture opens under the whole chip list: on a
 * message with six files the chips wrap to five rows on a phone, and a tap on
 * the first row puts the picture's top a hundred pixels below a pane whose
 * bottom edge the chip was sitting on.
 *
 * Never so far that the picture's top leaves the pane, so one taller than the
 * pane shows from its top down. That can take the pressed chip off the top of
 * the pane; the picture is what was asked for.
 *
 * And only ever down. A picture whose top is already above the pane is one
 * the agent has scrolled past — after "Try again", where the figure is what was
 * pressed and it has since grown by a whole picture — and taking them back up
 * to it is exactly the pulling back this exists not to do. In a browser that
 * does no scroll anchoring, a picture growing above the agent pushes them down
 * past it, so there it is the ordinary case rather than an edge.
 */
function revealInPane(figure: HTMLElement, pressed: HTMLElement) {
  let pane = figure.parentElement;
  while (
    pane &&
    !(
      /(auto|scroll)/.test(getComputedStyle(pane).overflowY) &&
      pane.scrollHeight > pane.clientHeight
    )
  ) {
    pane = pane.parentElement;
  }
  if (!pane) return;

  const view = pane.getBoundingClientRect();
  const anchor = pressed.getBoundingClientRect();
  const box = figure.getBoundingClientRect();
  const stillLooking = anchor.bottom > view.top && anchor.top < view.bottom;
  const distance = Math.min(box.bottom - view.bottom, box.top - view.top);
  if (!stillLooking || distance <= 0) return;

  pane.scrollBy({
    top: distance,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}
