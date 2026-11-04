'use client';

import { type SyntheticEvent, useRef, useState } from 'react';
import { DocumentIcon, ImageIcon, PaperclipIcon } from '@/components/icons';
import { canPlay, useOnClient } from '@/components/use-can-play';
import { isPreviewableImage, mediaFamily, playableMedia } from '@/lib/attachments/preview';
import { type MediaTrigger, shouldRefresh } from '@/lib/attachments/signed-url';
import { formatBytes } from '@/lib/format';
import type { WidgetAttachment } from '@/lib/widget/types';

/**
 * The files on one widget message, each drawn as what it is: a photo as the
 * photo, a recording as its player, and only what has nothing to show — a PDF,
 * an iPhone's HEIC, a recording this browser cannot play — as a link with its
 * name and size. The console's chat thread draws them the same way
 * (`MessageFiles`), because the visitor should see the photo they sent, not a
 * line saying they sent one.
 *
 * Each file is fetched through the link the transcript signed for it
 * (`lib/widget/file-links.ts`), which redirects to a short-lived Storage URL. A
 * file on a message still on its way has no link yet (`url: null`) and is drawn
 * as its name.
 *
 * A picture is `loading="lazy"`, a voice recording fetches nothing until play
 * and a video only its metadata, so a long chat costs what the visitor scrolls
 * to and listens to. Whether a recording plays is asked of the browser, as the
 * console does (`canPlay`): an older iPhone shows a player for Ogg Opus that
 * then plays nothing, where a link hands the file over. The answer exists only
 * in the browser, so the first render draws the link and the player follows.
 */
export function WidgetFiles({
  files,
  sendingLabel,
  dir,
  align,
}: {
  files: readonly WidgetAttachment[];
  sendingLabel: string;
  /**
   * The panel's direction, stated: the bubble round this reads its own from
   * its content (`dir="auto"`), and a Latin file name in the Arabic panel made
   * it left-to-right, which put `end` on the wrong side.
   */
  dir: 'ltr' | 'rtl';
  /** The sender's side, so files of different widths line up under each other there. */
  align: 'start' | 'end';
}) {
  const onClient = useOnClient();
  if (files.length === 0) return null;

  return (
    <div
      dir={dir}
      className={`flex max-w-full flex-col gap-1.5 ${align === 'end' ? 'items-end' : 'items-start'}`}
    >
      {files.map((file) => (
        <WidgetFile key={file.id} file={file} onClient={onClient} sendingLabel={sendingLabel} />
      ))}
    </div>
  );
}

function WidgetFile({
  file,
  onClient,
  sendingLabel,
}: {
  file: WidgetAttachment;
  onClient: boolean;
  sendingLabel: string;
}) {
  /*
    A file that would not load falls back to its link, which still hands it
    over — for the link it failed on. The component outlives its link: a push
    hands it a freshly signed one, and a widget left open overnight, whose
    links had expired into links, drew its pictures again on the morning's
    reply rather than staying a row of names until the panel was reloaded.
  */
  const [failedOn, setFailedOn] = useState<string | null>(null);
  const failed = failedOn !== null && failedOn === file.url;
  const setFailed = () => setFailedOn(file.url);
  /*
    Until a picture or a video knows its shape, it holds the largest box it can
    be. The thread scrolls to its end as a message arrives, before any picture
    in it has loaded, and one that then grew pushed itself below the fold — the
    visitor's own photo out of sight, on the iPhone most of all, which does no
    scroll anchoring. Held at its largest, a picture can only shrink when it
    loads, and a shrinking end of the thread stays at the end.
  */
  const [shaped, setShaped] = useState(false);
  const fresh = useFreshPlayer(setFailed);
  const url = file.url;
  const media = playableMedia(file.contentType);
  const playable = Boolean(media && onClient && canPlay(media));
  const frame = shaped ? '' : 'h-64 w-64';

  if (url && !failed && isPreviewableImage(file.contentType)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a signed, expiring URL behind a redirect, which the image optimiser can neither fetch nor cache
      <img
        src={url}
        alt={file.filename}
        loading="lazy"
        onLoad={() => setShaped(true)}
        onError={setFailed}
        className={`block max-h-64 max-w-full rounded-lg border border-(--color-border-subtle) bg-(--color-background-surface-sunken) object-contain ${frame}`}
      />
    );
  }

  if (url && !failed && playable && media?.kind === 'audio') {
    return (
      <audio
        src={url}
        controls
        preload="none"
        aria-label={file.filename}
        {...fresh}
        className="block h-12 w-64 max-w-full"
      />
    );
  }

  if (url && !failed && playable && media?.kind === 'video') {
    return (
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        aria-label={file.filename}
        {...fresh}
        onLoadedMetadata={(event) => {
          setShaped(true);
          fresh.onLoadedMetadata(event);
        }}
        className={`block max-h-64 max-w-full rounded-lg border border-(--color-border-subtle) bg-black ${frame}`}
      />
    );
  }

  const family = mediaFamily(file.contentType);
  const Icon =
    family === 'image' || family === 'video' ? ImageIcon : family ? PaperclipIcon : DocumentIcon;
  const content = (
    <>
      <Icon size={16} className="shrink-0 text-(--color-text-tertiary)" />
      {/* Isolated, so a Latin name inside the Arabic panel keeps its own order. */}
      <bdi className="min-w-0 truncate">{file.filename}</bdi>
      {/* A size is written left to right in either language: "125 B", not "B 125". */}
      {url ? (
        <span dir="ltr" className="shrink-0 text-(--color-text-tertiary) tabular-nums">
          {formatBytes(file.sizeBytes)}
        </span>
      ) : (
        <span className="shrink-0 text-(--color-text-tertiary)">{sendingLabel}</span>
      )}
    </>
  );

  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className={`${CHIP} hover:underline`}>
      {content}
    </a>
  ) : (
    <span className={CHIP}>{content}</span>
  );
}

type MediaEvent = SyntheticEvent<HTMLMediaElement>;

/** Reloads before giving up, so one bad network moment is not the end of a player. */
const MAX_RELOADS = 2;

/**
 * A player that goes back through its link when the Storage URL behind it has
 * expired, rather than turning into a link.
 *
 * The route signs Storage URLs for five minutes, and after its redirect every
 * later range request goes straight to the signed URL — never back through the
 * route — so a video paused past that, or a long recording resumed past what it
 * buffered, asks Storage with a dead signature. `shouldRefresh` is the
 * console's decision of when that is about to happen or has, with the evidence
 * for it; this is the widget's smaller use of it. A reload asks the link again,
 * which signs a fresh URL, and puts the position and the playing back.
 */
function useFreshPlayer(onFail: () => void) {
  const minted = useRef<number | null>(null);
  const playing = useRef(false);
  const reloads = useRef(0);
  const lastData = useRef<number | null>(null);
  const resume = useRef<{ at: number; play: boolean } | null>(null);

  const consider = (trigger: MediaTrigger, media: HTMLMediaElement) => {
    const buffered: Array<[number, number]> = [];
    for (let range = 0; range < media.buffered.length; range++) {
      buffered.push([media.buffered.start(range), media.buffered.end(range)]);
    }
    const refresh = shouldRefresh(trigger, {
      ageMs: minted.current === null ? null : performance.now() - minted.current,
      position: media.currentTime,
      duration: media.duration,
      buffered,
      errorCode: media.error?.code ?? null,
      readyState: media.readyState,
      sinceDataMs: lastData.current === null ? null : performance.now() - lastData.current,
    });
    if (!refresh) {
      if (trigger === 'error') onFail();
      return;
    }
    if (reloads.current >= MAX_RELOADS) {
      onFail();
      return;
    }
    reloads.current += 1;
    resume.current ??= { at: media.currentTime, play: playing.current || !media.paused };
    minted.current = null;
    lastData.current = null;
    media.load();
  };

  return {
    onLoadedMetadata: (event: MediaEvent) => {
      const media = event.currentTarget;
      minted.current = performance.now();
      const back = resume.current;
      resume.current = null;
      if (!back) return;
      media.currentTime = back.at;
      // Refused only where the browser wants a fresh tap; the controls are there.
      if (back.play) {
        media.play().catch(() => {
          playing.current = false;
        });
      }
    },
    onPlay: (event: MediaEvent) => {
      playing.current = true;
      consider('play', event.currentTarget);
    },
    onPause: () => {
      playing.current = false;
    },
    onEnded: () => {
      playing.current = false;
    },
    onSeeking: (event: MediaEvent) => consider('seeking', event.currentTarget),
    onWaiting: (event: MediaEvent) => consider('waiting', event.currentTarget),
    onStalled: (event: MediaEvent) => consider('stalled', event.currentTarget),
    onProgress: () => {
      lastData.current = performance.now();
    },
    onError: (event: MediaEvent) => consider('error', event.currentTarget),
  };
}

/** A file in the thread, at the size the console's chips are drawn. */
const CHIP =
  'inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2 text-xs text-(--color-text-primary)';
