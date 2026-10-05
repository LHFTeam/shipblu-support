'use client';

import { useId, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { isPreviewableImage } from '@/lib/attachments/preview';
import { formatBytes } from '@/lib/format';

type Attachment = { id: string; filename: string; contentType: string; sizeBytes: number };

/**
 * The files on one message: a row of chips, where a picture opens under the row
 * instead of in a new tab.
 *
 * In place rather than in a lightbox. This codebase has no modals (see
 * `ShipmentsField`), and the timeline's order is its information: the
 * photograph of a crushed box belongs beside the sentence complaining about it,
 * not in a layer over the whole ticket. Anything that is not a picture stays a
 * link, because a PDF or a spreadsheet has nothing to show in a bubble.
 *
 * Nothing is fetched until it is clicked. Every picture is a signed URL minted
 * per request by `/api/attachments/[id]`, so an eager thumbnail would be a
 * Storage round trip per image each time a ticket opened — and every photo on a
 * long WhatsApp thread downloaded to an agent's phone whether or not anybody
 * looked at it. A preview stays mounted once opened, so hiding and showing it
 * again costs nothing: its URL expired minutes ago, but the decoded picture is
 * still in hand, and a fresh `<img>` would mint another.
 *
 * `compact` is the side conversation card's density, which sits inside a
 * ticket's timeline and so draws everything a step smaller.
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

  return (
    <>
      <ul className={compact ? 'mt-1.5 flex flex-wrap gap-1.5' : 'mt-2 flex flex-wrap gap-2'}>
        {files.map((file) => {
          const showing = previews[file.id] === true;

          return (
            <li
              key={file.id}
              className={
                compact
                  ? 'rounded border border-[var(--border)] px-1.5 py-0.5 text-xs'
                  : 'rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs'
              }
            >
              {isPreviewableImage(file.contentType) ? (
                <button
                  type="button"
                  onClick={() =>
                    setPreviews((current) => ({ ...current, [file.id]: !current[file.id] }))
                  }
                  aria-expanded={showing}
                  // Only once the preview exists: before the first click there
                  // is nothing in the document for it to name.
                  aria-controls={previews[file.id] === undefined ? undefined : previewId(file)}
                  className="inline-flex items-center gap-0.5 text-start hover:underline"
                >
                  {file.filename}
                  {showing ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
                </button>
              ) : (
                <a
                  href={`/api/attachments/${file.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {file.filename}
                </a>
              )}
              <span
                className={compact ? 'ms-1 opacity-60' : 'ms-1.5 text-[var(--muted-foreground)]'}
              >
                {formatBytes(file.sizeBytes)}
              </span>
            </li>
          );
        })}
      </ul>

      {opened.length > 0 ? (
        <div className="mt-2 flex flex-col items-start gap-2">
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
 * both cases the file is still one click away.
 */
function ImagePreview({ id, file, hidden }: { id: string; file: Attachment; hidden: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const href = `/api/attachments/${file.id}`;

  return (
    <figure id={id} hidden={hidden} className="max-w-full">
      {state === 'failed' ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          {file.filename} could not be shown here.{' '}
          <a href={href} target="_blank" rel="noreferrer" className="underline">
            Open the file
          </a>
        </p>
      ) : (
        <a
          href={href}
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
            src={href}
            alt={file.filename}
            decoding="async"
            onLoad={() => setState('loaded')}
            onError={() => setState('failed')}
            className="block max-h-96 max-w-full cursor-zoom-in rounded-md border border-[var(--border)] bg-[var(--surface)]"
          />
        </a>
      )}
      {state === 'loading' ? (
        <p className="text-xs text-[var(--muted-foreground)]">Loading picture…</p>
      ) : null}
    </figure>
  );
}
