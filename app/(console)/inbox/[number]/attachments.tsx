'use client';

import {
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { isPreviewableImage, type PlayableMedia, playableMedia } from '@/lib/attachments/preview';
import {
  initialPreviewState,
  type Load,
  loadOf,
  playerName,
  previewFile,
  previewReducer,
} from '@/lib/attachments/previews';
import { type MediaTrigger, shouldRefresh } from '@/lib/attachments/signed-url';
import { formatBytes } from '@/lib/format';

type Attachment = { id: string; filename: string; contentType: string; sizeBytes: number };

/** What an attachment can be in the conversation; null is a plain link. */
type Kind = 'image' | 'audio' | 'video' | null;

/** What was pressed to ask for a picture, which is where the agent is looking. */
type Pressed = 'chip' | 'figure';

const fileUrl = (file: Attachment) => `/api/attachments/${file.id}`;

/*
  Elements are found by id when a handler or the reveal needs one, rather than
  held in maps filled by ref callbacks: an inline callback is a new function
  every render, so React detached and reattached every chip and figure on every
  load, toggle and notice to keep maps nobody read in between.
*/
const previewIdFor = (baseId: string, fileId: string) => `${baseId}-${fileId}`;
const chipIdFor = (baseId: string, fileId: string) => `${baseId}-${fileId}-chip`;

/*
  Whether this browser plays a media type is only known in the browser, and a
  WhatsApp voice note is the case that varies: Ogg Opus plays on an iPhone from
  iOS 18.4, and before it a player shows a duration and then plays nothing. So
  the server draws every media file as the link it always was, and the client
  draws the player once it has asked. `useSyncExternalStore` with a server
  snapshot is what lets the first client render match the server's, as
  `components/use-now.ts` does for the clock.
*/
const subscribeToNothing = () => () => {};
const useOnClient = () =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

const verdicts = new Map<string, boolean>();

function canPlay(media: PlayableMedia): boolean {
  const key = `${media.kind} ${media.probe}`;
  let verdict = verdicts.get(key);
  if (verdict === undefined) {
    verdict = document.createElement(media.kind).canPlayType(media.probe) !== '';
    verdicts.set(key, verdict);
  }
  return verdict;
}

/**
 * The files on one message: a row of chips, where a picture opens under the row
 * instead of in a new tab.
 *
 * In place rather than in a lightbox, because the timeline's order is its
 * information: the photograph of a crushed box belongs beside the sentence
 * complaining about it, not in a layer over the whole ticket. Anything that is not a picture is left
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
 * looked at it. A preview stays mounted once opened, so hiding it with its chip
 * and showing it again costs nothing. A fresh `<img>` would ask the route again,
 * which mints another URL, unless the browser answered it from its list of
 * available images — which the HTML spec lets it empty at any time — so this
 * does not ask. Collapsing a whole side conversation thread is a reset instead,
 * as it already is for the reply the agent was typing there, so its pictures
 * start closed again.
 *
 * `compact` is the side conversation card's density for the chip row, which
 * that card has always drawn a step smaller. An opened picture is the same size
 * at both, because the picture is what the agent opened it to read.
 *
 * Recorded media plays here too, wherever the browser says it can (see
 * `canPlay`):
 *
 * - **A voice note's player is on the page from the start**, under the chips,
 *   because listening is the whole of reading one. `preload="none"` keeps the
 *   promise above: every engine fetches nothing for it until play is pressed,
 *   so a thread of forty notes costs nothing until somebody listens. They are
 *   small (the largest in production is about 200 KB), so the first response
 *   carries the whole note.
 * - **A video opens from its chip**, like a picture, because it is not small —
 *   a WhatsApp video runs to tens of megabytes.
 * - **Only one plays at a time.** Two voice notes talking over each other is
 *   never what was meant.
 */
export function AttachmentList({
  files,
  compact = false,
}: {
  files: Attachment[];
  compact?: boolean;
}) {
  const baseId = useId();
  const onClient = useOnClient();
  const [state, dispatch] = useReducer(previewReducer, initialPreviewState);
  /*
    Pictures waiting to be brought into view, each with what was pressed to ask
    for it, oldest first.

    Written only by the agent's clicks, so a live update re-rendering the list
    with a picture open never moves the pane. An entry is spent by its reveal,
    or dropped when its preview turns out closed. One per picture, so closing
    one picture to make room does not cancel the reveal of another still
    loading.
  */
  const pending = useRef(new Map<string, Pressed>());

  useEffect(() => {
    // One reveal per commit, the latest ask. Two calls would each measure the
    // pane before either had moved it, and the second smooth scroll cancels the
    // first mid-flight — so two pictures settling together showed neither.
    let latest: [string, Pressed] | null = null;
    for (const [id, pressed] of pending.current) {
      if (state.showing[id] !== true) {
        pending.current.delete(id);
        continue;
      }
      if (loadOf(state, id) === 'loading') continue;
      pending.current.delete(id);
      latest = [id, pressed];
    }
    if (!latest) return;

    const [id, pressed] = latest;
    const figure = document.getElementById(previewIdFor(baseId, id));
    const anchor = pressed === 'chip' ? document.getElementById(chipIdFor(baseId, id)) : figure;
    if (figure && anchor) revealInPane(figure, anchor);
  }, [state, baseId]);

  if (files.length === 0) return null;

  const kindOf = (file: Attachment): Kind => {
    if (isPreviewableImage(file.contentType)) return 'image';
    const media = playableMedia(file.contentType);
    return media && onClient && canPlay(media) ? media.kind : null;
  };
  const asPreview = (file: Attachment) => previewFile(file, kindOf(file) ?? undefined);
  const previewId = (file: Attachment) => previewIdFor(baseId, file.id);
  const figureOf = (file: Attachment) => document.getElementById(previewId(file));
  // Deleted first so the newest ask is the last entry, which is the one the
  // reveal takes.
  const ask = (file: Attachment, pressed: Pressed) => {
    pending.current.delete(file.id);
    pending.current.set(file.id, pressed);
  };
  const opened = files.filter((file) => state.showing[file.id] !== undefined);
  const voiceNotes = files.filter((file) => kindOf(file) === 'audio');

  const toggle = (event: MouseEvent<HTMLAnchorElement>, file: Attachment) => {
    // A modified click means what it means on any link — a background tab, a
    // new window, a download — so it is left to the browser. Enter on a
    // focused link arrives here as a plain click.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    ask(file, 'chip');
    dispatch({ type: 'toggle', file: asPreview(file) });
  };

  const retry = (file: Attachment) => {
    // The button pressed is about to unmount with the failure line, which
    // would drop focus to <body> — and a screen reader whose focused node
    // vanishes loses its place in the ticket. The figure stays.
    figureOf(file)?.focus({ preventScroll: true });
    // The figure, not the chip: the agent was looking at "Try again", which may
    // be a whole picture's height below the chip. A voice note is already where
    // it was, and loads nothing until play is pressed again.
    if (kindOf(file) !== 'audio') ask(file, 'figure');
    dispatch({ type: 'retry', file: asPreview(file) });
  };

  const settle = (file: Attachment, load: 'loaded' | 'failed') => {
    const figure = figureOf(file);
    if (load === 'failed' && figure?.contains(document.activeElement)) {
      // The same rescue as `retry`, for the other thing a failure unmounts: the
      // picture's own link, which Tab reaches while it is still loading — and
      // reaches first after "Try again", so a second failure would otherwise
      // drop focus exactly where the first one was caught.
      figure.focus({ preventScroll: true });
    } else if (load === 'loaded' && figure && document.activeElement === figure) {
      // Focus parked on the figure by "Try again" moves on to the picture's
      // link once it loads, so the next thing a screen reader says is what the
      // retry produced — the figure's name alone does not say it worked. A
      // player takes focus as soon as it mounts instead (see `Player`), because
      // a voice note loads nothing until play is pressed.
      figure.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
    }
    dispatch({ type: 'settle', file: asPreview(file), load });
  };

  return (
    // Positioned for the live region's sake. `sr-only` is `position: absolute`,
    // and a box with no positioned ancestor is placed against the document —
    // past every `overflow-hidden` up to the shell — stretching the page under
    // the console until scrolling past the timeline's end took the console off
    // the screen (PROJECT-STATE §6.81). The timeline pane is positioned now as
    // well; this keeps the list safe wherever else it is mounted.
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
            {kindOf(file) === 'image' || kindOf(file) === 'video' ? (
              <a
                id={chipIdFor(baseId, file.id)}
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
      {files.some(
        (file) => isPreviewableImage(file.contentType) || playableMedia(file.contentType),
      ) ? (
        <span role="status" className="sr-only">
          {state.notice ? <span key={state.notice.seq}>{state.notice.text}</span> : null}
        </span>
      ) : null}

      {voiceNotes.length > 0 ? (
        <div className={compact ? 'mt-1.5 flex flex-col gap-1.5' : 'mt-2 flex flex-col gap-2'}>
          {voiceNotes.map((file) => (
            <MediaFigure
              key={file.id}
              id={previewId(file)}
              label={
                loadOf(state, file.id) === 'failed'
                  ? playerName('audio', file.sizeBytes)
                  : undefined
              }
            >
              <MediaPlayer
                kind="audio"
                file={file}
                load={loadOf(state, file.id)}
                onSettle={(load) => settle(file, load)}
                onRetry={() => retry(file)}
              />
            </MediaFigure>
          ))}
        </div>
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
            <MediaFigure
              key={file.id}
              id={previewId(file)}
              label={
                kindOf(file) === 'image'
                  ? file.filename
                  : loadOf(state, file.id) === 'failed'
                    ? playerName('video', file.sizeBytes)
                    : undefined
              }
              hidden={state.showing[file.id] !== true}
            >
              {kindOf(file) === 'video' ? (
                <MediaPlayer
                  kind="video"
                  file={file}
                  hidden={state.showing[file.id] !== true}
                  load={loadOf(state, file.id)}
                  onSettle={(load) => settle(file, load)}
                  onRetry={() => retry(file)}
                />
              ) : (
                <ImagePreview
                  file={file}
                  load={loadOf(state, file.id)}
                  onSettle={(load) => settle(file, load)}
                  onRetry={() => retry(file)}
                />
              )}
            </MediaFigure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The frame every opened picture, video and voice note sits in.
 *
 * It takes focus (`tabIndex={-1}`, so never by Tab) for two hand-overs: "Try
 * again" parks focus on it before unmounting itself (see `retry`), and a
 * failure moves focus to it when the control that had it is gone (see
 * `settle`). A picture's figure is named after the file, so that focus lands on
 * something a screen reader can say while the picture loads. A player's is
 * named only while it holds the failure line: a working player carries its own
 * name, and focus moves straight on to it after a retry, so a figure named as
 * well would be the same words read twice.
 */
function MediaFigure({
  id,
  label,
  hidden = false,
  children,
}: {
  id: string;
  label?: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <figure id={id} hidden={hidden} tabIndex={-1} aria-label={label} className="max-w-full">
      {children}
    </figure>
  );
}

/**
 * What a file that would not load says instead, keeping the link: the bytes may
 * be fine and only this browser unable to decode them, or the session may have
 * lapsed since the page was drawn, and in both cases the file is still one
 * click away.
 */
function Failure({
  file,
  name,
  verb,
  onRetry,
}: {
  file: Attachment;
  name: string;
  verb: 'shown' | 'played';
  onRetry: () => void;
}) {
  const failureId = `${useId()}-failure`;

  return (
    <p className="text-xs text-[var(--muted-foreground)]">
      <span id={failureId}>
        {name} could not be {verb} here.
      </span>{' '}
      {/* Described by the sentence rather than renamed, so the name stays
          the label on screen for voice control, and each control says which
          file it is about when it takes focus. A list of names alone — a
          rotor, an elements list — still shows two "Try again"s when two
          files fail; a name that differed from the label would be the worse
          trade. */}
      <button type="button" onClick={onRetry} aria-describedby={failureId} className="underline">
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
  );
}

/**
 * One picture, linked to the original for when the detail matters — the
 * tracking number on a photographed label is often only legible full size.
 *
 * "Try again" draws a new `<img>`, which asks the route again: a failed load is
 * never in the browser's list of available images to be answered from, so a
 * Storage timeout a moment ago does not decide what the agent sees now.
 */
function ImagePreview({
  file,
  load,
  onSettle,
  onRetry,
}: {
  file: Attachment;
  load: Load;
  onSettle: (load: 'loaded' | 'failed') => void;
  onRetry: () => void;
}) {
  if (load === 'failed') {
    return <Failure file={file} name={file.filename} verb="shown" onRetry={onRetry} />;
  }

  return (
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
  );
}

/**
 * How many failed reloads a player makes in one place before giving up.
 *
 * Only an error counts, and the count clears once playback has moved on a few
 * seconds past where it failed. Clearing it on "playing" instead let a file
 * that broke at the same second play, fail, reload and play again forever.
 * The reloads made ahead of an expiry do not count: they are already limited
 * to one per URL lifetime by its age.
 */
const MAX_FAILURES = 3;
const PROGRESS_SECONDS = 5;

/**
 * How recently before an error focus has to have left a player for nowhere for
 * the error to have taken it. Chromium 141 blurs the control a few
 * milliseconds before it reports one; a click elsewhere is not that close.
 */
const DROPPED_FOCUS_MS = 100;

/**
 * A voice note or a video, with the native controls — which already carry play,
 * seek, speed and volume, and are accessible, on every platform the console is
 * read on.
 *
 * A voice note is `preload="none"`: nothing is fetched until play. A video
 * fetches its metadata as soon as it is opened, because opening it was the
 * agent asking for it, and the first frame and the shape of the box come with
 * the metadata.
 *
 * A video with no picture draws as a bar of controls rather than a black
 * rectangle, once its metadata says so. Usually it is a Facebook voice clip,
 * which arrives as MP4; it can also be a video whose picture this browser
 * cannot decode but whose sound it can, which is what the file shows in a tab
 * of the same browser too (see `PLAYABLE`).
 *
 * A hidden video is paused: hiding it with its chip is not asking for its sound
 * to carry on from nowhere.
 */
function MediaPlayer({
  kind,
  file,
  hidden = false,
  load,
  onSettle,
  onRetry,
}: {
  kind: 'audio' | 'video';
  file: Attachment;
  hidden?: boolean;
  load: Load;
  onSettle: (load: 'loaded' | 'failed') => void;
  onRetry: () => void;
}) {
  if (load === 'failed') {
    return (
      <Failure
        file={file}
        name={playerName(kind, file.sizeBytes)}
        verb="played"
        onRetry={onRetry}
      />
    );
  }
  // A separate component so that "Try again" mounts a new one: the element and
  // `useFreshMedia`'s count of reloads start over together, rather than a new
  // element inheriting a spent count and a "ready" it never reached.
  return <Player kind={kind} file={file} hidden={hidden} load={load} onSettle={onSettle} />;
}

function Player({
  kind,
  file,
  hidden,
  load,
  onSettle,
}: {
  kind: 'audio' | 'video';
  file: Attachment;
  hidden: boolean;
  load: Load;
  onSettle: (load: 'loaded' | 'failed') => void;
}) {
  const element = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [soundOnly, setSoundOnly] = useState(false);
  const fresh = useFreshMedia({
    onReady: (media) => {
      if (media instanceof HTMLVideoElement && media.videoWidth === 0) setSoundOnly(true);
      onSettle('loaded');
    },
    onFail: () => onSettle('failed'),
  });

  useEffect(() => {
    if (hidden) element.current?.pause();
  }, [hidden]);

  // Mounted by "Try again", which parked focus on the figure: hand it to the
  // new player, so a screen reader names what the retry produced. A voice note
  // fetches nothing until play, so waiting for it to load would wait forever.
  useEffect(() => {
    const media = element.current;
    if (media && document.activeElement === media.closest('figure')) {
      media.focus({ preventScroll: true });
    }
  }, []);

  const name = playerName(kind, file.sizeBytes);

  if (kind === 'audio') {
    return (
      <audio
        ref={element}
        src={fileUrl(file)}
        controls
        preload="none"
        aria-label={name}
        // A width of its own, as the sound-only video has below: a share of a
        // bubble that shrinks to fit its text squeezed the player to the
        // width of the chips and dropped its duration.
        className="block w-80 max-w-full"
        {...fresh}
      />
    );
  }

  return (
    <>
      <video
        ref={element}
        src={fileUrl(file)}
        controls
        playsInline
        preload="metadata"
        aria-label={name}
        className={
          // A width of its own, not a share of the figure's: the figure shrinks
          // to fit what it holds, and Firefox gives a video with no picture a
          // 2:1 shape, so at 48px tall the bar shrank to 96px wide and lost its
          // scrubber and its time.
          soundOnly
            ? 'block h-12 w-80 max-w-full'
            : 'block max-h-96 max-w-full rounded-md border border-[var(--border)] bg-black'
        }
        {...fresh}
      />
      {load === 'loading' ? (
        <p className="text-xs text-[var(--muted-foreground)]">Loading video…</p>
      ) : null}
    </>
  );
}

/**
 * One player at a time, across the whole ticket rather than this message's
 * list: two voice notes talking over each other, or a note under a video, is
 * never what was meant.
 */
function pauseOthers(playing: HTMLMediaElement) {
  for (const media of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (media !== playing) media.pause();
  }
}

type MediaEvent = SyntheticEvent<HTMLMediaElement>;

/** Whether some other player on the page is sounding. */
function anotherPlaying(media: HTMLMediaElement) {
  for (const other of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (other !== media && !other.paused) return true;
  }
  return false;
}

/**
 * Keeps a player's signed URL alive for as long as somebody is listening, and
 * says when it cannot be played at all.
 *
 * The route answers with a signed Storage URL that lasts five minutes, and
 * every browser sends its later range requests straight to that URL, never back
 * through the route — `shouldRefresh` has the evidence, and decides when a play,
 * a seek or a stall has to go back for a fresh signature. A reload does that
 * through `load()`, and puts the position, the speed and the playing state
 * back. Before metadata nothing has been signed yet, which is why the URL's age
 * runs from `loadedmetadata` and not from `loadstart`: with `preload="none"`,
 * `loadstart` fires when the page renders, and a note played four minutes later
 * would reload on its very first press.
 *
 * The age is the larger of wall-clock and monotonic time since then.
 * `performance.now()` stops while a laptop or phone sleeps, and a phone in a
 * pocket is exactly when a paused note goes stale. `Date.now()` keeps counting
 * through sleep but jumps when the clock is set. Taking the larger means
 * neither one can make a dead URL look young.
 *
 * Whether to play on is taken from `play`, `pause` and `ended` as they arrive,
 * and from the element itself: Chromium fires `pause` only after it reports a
 * failed range, and a `play()` can land while a reload is in flight.
 *
 * A reload's resume is a promise to play again, not an order. If the video was
 * hidden while the reload was in flight, or the agent started another player,
 * `load()` has already set the element paused without firing `pause`, so
 * nothing else could have cancelled it. It is checked when the metadata lands.
 *
 * While a reload ahead of an expiry is in flight, a video keeps the box it had.
 * `load()` drops the picture's size until the metadata is back, and the default
 * 300 × 150 it fell back to moved the controls out from under the pointer and
 * the conversation below by hundreds of pixels. A reload after an error is left
 * alone: measuring an element in its error state lets Chrome render that state,
 * and Chrome then takes focus off the control the agent was on.
 *
 * Focus stays with the player through a reload. `document.activeElement` is
 * the element itself while one of its native controls — play, the scrubber —
 * has focus, and Chromium 141 takes focus off that control to nowhere inside
 * `load()`, and just before it reports an error. Left there, the next key
 * reached nothing, and a screen reader lost its place in the ticket.
 *
 * An error before the first metadata is not an expiry. The format, the file or
 * the session is the problem, and the failure line says so.
 */
function useFreshMedia({
  onReady,
  onFail,
}: {
  onReady: (media: HTMLMediaElement) => void;
  onFail: () => void;
}) {
  const minted = useRef<{ wall: number; mono: number } | null>(null);
  const ready = useRef(false);
  const playing = useRef(false);
  const failures = useRef(0);
  const failedAt = useRef<number | null>(null);
  const resume = useRef<{ at: number; rate: number; play: boolean } | null>(null);
  /** When bytes last arrived, for telling a slow response from a refused one. */
  const lastData = useRef<number | null>(null);
  /** When focus last left the player for nowhere. */
  const focusDropped = useRef<number | null>(null);

  const ageMs = () =>
    minted.current === null
      ? null
      : Math.max(Date.now() - minted.current.wall, performance.now() - minted.current.mono);

  const giveUp = (media: HTMLMediaElement) => {
    resume.current = null;
    playing.current = false;
    // Back on the element first, so `settle` hands it to the failure line as
    // it would from the element itself.
    const dropped = focusDropped.current;
    if (nothingFocused() && dropped !== null && performance.now() - dropped < DROPPED_FOCUS_MS) {
      media.focus({ preventScroll: true });
    }
    onFail();
  };

  const reload = (media: HTMLMediaElement, failed: boolean) => {
    if (failed) {
      if (failures.current >= MAX_FAILURES) return giveUp(media);
      failures.current += 1;
      failedAt.current = resume.current?.at ?? media.currentTime;
    }
    resume.current ??= {
      at: media.currentTime,
      rate: media.playbackRate,
      play: playing.current || !media.paused,
    };
    minted.current = null;
    lastData.current = null;
    // `load()` resets the speed to the default, so the default becomes the
    // speed the agent chose.
    media.defaultPlaybackRate = resume.current.rate;
    if (!failed && media instanceof HTMLVideoElement) {
      const box = media.getBoundingClientRect();
      if (box.width > 0) {
        media.style.width = `${box.width}px`;
        media.style.height = `${box.height}px`;
      }
    }
    const focused = document.activeElement === media;
    media.load();
    if (focused && document.activeElement !== media) media.focus({ preventScroll: true });
  };

  const consider = (trigger: MediaTrigger, media: HTMLMediaElement) => {
    const buffered: Array<[number, number]> = [];
    for (let range = 0; range < media.buffered.length; range++) {
      buffered.push([media.buffered.start(range), media.buffered.end(range)]);
    }
    if (
      !shouldRefresh(trigger, {
        ageMs: ageMs(),
        position: media.currentTime,
        duration: media.duration,
        buffered,
        errorCode: media.error?.code ?? null,
        readyState: media.readyState,
        sinceDataMs: lastData.current === null ? null : performance.now() - lastData.current,
      })
    ) {
      return false;
    }
    reload(media, trigger === 'error');
    return true;
  };

  return {
    onLoadedMetadata: (event: MediaEvent) => {
      const media = event.currentTarget;
      minted.current = { wall: Date.now(), mono: performance.now() };
      media.style.removeProperty('width');
      media.style.removeProperty('height');
      const back = resume.current;
      resume.current = null;
      if (back) {
        media.currentTime = back.at;
        media.playbackRate = back.rate;
        if (back.play && !media.closest('[hidden]') && !anotherPlaying(media)) {
          // Refused only where the browser wants a fresh tap; the controls are
          // right there for it.
          media.play().catch(() => {
            playing.current = false;
          });
        } else {
          // Paused by `load()`, unless the agent pressed play while it was in
          // flight.
          playing.current = !media.paused;
        }
        return;
      }
      if (!ready.current) {
        ready.current = true;
        onReady(media);
      }
    },
    onPlay: (event: MediaEvent) => {
      playing.current = true;
      pauseOthers(event.currentTarget);
      consider('play', event.currentTarget);
    },
    onPause: () => {
      playing.current = false;
    },
    onEnded: () => {
      playing.current = false;
    },
    onTimeUpdate: (event: MediaEvent) => {
      if (
        failedAt.current !== null &&
        event.currentTarget.currentTime > failedAt.current + PROGRESS_SECONDS
      ) {
        failures.current = 0;
        failedAt.current = null;
      }
    },
    onSeeking: (event: MediaEvent) => {
      consider('seeking', event.currentTarget);
    },
    onWaiting: (event: MediaEvent) => {
      consider('waiting', event.currentTarget);
    },
    onStalled: (event: MediaEvent) => {
      consider('stalled', event.currentTarget);
    },
    onProgress: () => {
      lastData.current = performance.now();
    },
    onFocus: () => {
      focusDropped.current = null;
    },
    onBlur: (event: FocusEvent<HTMLMediaElement>) => {
      focusDropped.current = event.relatedTarget === null ? performance.now() : null;
    },
    onError: (event: MediaEvent) => {
      const media = event.currentTarget;
      // A reload that itself failed counts as a failure, and tries again from
      // where it was going.
      if (resume.current) return reload(media, true);
      if (!ready.current || !consider('error', media)) giveUp(media);
    },
  };
}

/** Focus has gone nowhere: nothing took it over. */
function nothingFocused() {
  return document.activeElement === null || document.activeElement === document.body;
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
