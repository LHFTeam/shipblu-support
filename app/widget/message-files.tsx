'use client';

import { useState, useSyncExternalStore } from 'react';
import { DocumentIcon, ImageIcon, PaperclipIcon } from '@/components/icons';
import {
  isPreviewableImage,
  mediaFamily,
  type PlayableMedia,
  playableMedia,
} from '@/lib/attachments/preview';
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
 * Each file is fetched through `/api/widget/attachments/[id]`, which checks the
 * visitor's token and redirects to a signed URL, so `urlFor` carries the token.
 * A file on a message still on its way (`pending`) has no stored copy yet and is
 * drawn as its link without the link.
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
  urlFor,
  sendingLabel,
  dir,
  align,
}: {
  files: readonly WidgetAttachment[];
  urlFor: (file: WidgetAttachment) => string;
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
        <WidgetFile
          key={file.id}
          file={file}
          url={file.pending ? null : urlFor(file)}
          onClient={onClient}
          sendingLabel={sendingLabel}
        />
      ))}
    </div>
  );
}

function WidgetFile({
  file,
  url,
  onClient,
  sendingLabel,
}: {
  file: WidgetAttachment;
  url: string | null;
  onClient: boolean;
  sendingLabel: string;
}) {
  // A file that would not load falls back to its link, which still hands it over.
  const [failed, setFailed] = useState(false);
  const media = playableMedia(file.contentType);
  const playable = Boolean(media && onClient && canPlay(media));

  if (url && !failed && isPreviewableImage(file.contentType)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a signed, expiring URL behind a redirect, which the image optimiser can neither fetch nor cache
      <img
        src={url}
        alt={file.filename}
        loading="lazy"
        onError={() => setFailed(true)}
        className="block max-h-64 max-w-full rounded-lg border border-(--color-border-subtle) bg-(--color-background-surface-sunken) object-contain"
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
        onError={() => setFailed(true)}
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
        onError={() => setFailed(true)}
        className="block max-h-64 max-w-full rounded-lg border border-(--color-border-subtle) bg-black"
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
      <span className="shrink-0 text-(--color-text-tertiary) tabular-nums">
        {url ? formatBytes(file.sizeBytes) : sendingLabel}
      </span>
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

/** A file in the thread, at the size the console's chips are drawn. */
const CHIP =
  'inline-flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2 text-xs text-(--color-text-primary)';

/*
  Whether this browser plays a type is only known in the browser. The server's
  snapshot says no, so the first client render matches the server's, as the
  console's attachments do.
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
