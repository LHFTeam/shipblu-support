// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { MediaLook } from '@/lib/tickets/message-media';
import { MessageFiles } from './attachments';

/**
 * What the thread draws for a message's files: each one once, without a click,
 * and still the same element after `LiveUpdates` re-renders the ticket — a new
 * `<img>` would mint another signed URL and download the picture again.
 *
 * happy-dom plays nothing, so `canPlayType` is stubbed where a player is the
 * point, and a recording it is not asked about stays a link, as it does in a
 * browser that cannot play it. `.ts` with `createElement`, as
 * `components/chat.test.ts` explains.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Ogg Opus and WebM play here; MP4 does not, so a voice note's player and a
  // recording left as a link can both be seen.
  HTMLMediaElement.prototype.canPlayType = (type: string) =>
    type.includes('ogg') || type.includes('webm') ? 'probably' : '';
});

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

const photo = {
  id: 'p1',
  filename: '1002979522811778.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 88_064,
};
const note = {
  id: 'n1',
  filename: '1011360668584057.ogg',
  contentType: 'audio/ogg',
  sizeBytes: 21_504,
};
const pdf = { id: 'd1', filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 589 };
const clip = { id: 'c1', filename: 'm-0.mp4', contentType: 'video/mp4', sizeBytes: 150_000 };
const webm = { id: 'w1', filename: 'm-0.webm', contentType: 'video/webm', sizeBytes: 150_000 };

function draw(files: (typeof photo)[], looks?: ReadonlyMap<string, MediaLook>) {
  host ??= document.createElement('div');
  if (!host.isConnected) document.body.append(host);
  root ??= createRoot(host);
  act(() => root!.render(createElement(MessageFiles, { files, looks })));
  return host;
}

describe('MessageFiles', () => {
  it('draws a picture without a click, and nothing naming it after its media id', () => {
    const view = draw([photo]);

    const img = view.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/attachments/p1');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('alt')).toBe('Picture, 86 KB');
    expect(view.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Open Picture, 86 KB full size in a new tab',
    );
    expect(view.textContent).not.toContain(photo.filename);
    expect(view.querySelector('li')).toBeNull();
  });

  it('keeps the same picture element when the ticket re-renders', () => {
    const before = draw([photo]).querySelector('img');
    const after = draw([{ ...photo }]).querySelector('img');
    expect(after).toBe(before);
  });

  it('settles a picture that loads, and drops the frame it waited in', () => {
    const view = draw([photo]);
    const frame = view.querySelector('a')!;
    expect(frame.className).toContain('h-80');

    act(() => {
      view.querySelector('img')!.dispatchEvent(new Event('load'));
    });
    expect(view.querySelector('a')).toBe(frame);
    expect(frame.className).not.toContain('h-80');
    expect(view.querySelector('img')!.className).toContain('max-h-80');
  });

  it('draws a voice note as its player alone', () => {
    const view = draw([note]);
    const audio = view.querySelector('audio');
    expect(audio?.getAttribute('preload')).toBe('none');
    expect(audio?.getAttribute('aria-label')).toBe('Audio, 21 KB');
    expect(view.querySelector('li')).toBeNull();
    expect(view.textContent).not.toContain(note.filename);
  });

  it('links a file there is nothing to show of, by name', () => {
    const link = draw([pdf]).querySelector('li a');
    expect(link?.textContent).toBe('invoice.pdf');
    expect(link?.getAttribute('href')).toBe('/api/attachments/d1');
  });

  it('names a recording this browser cannot play by what it is', () => {
    const view = draw([clip]);
    expect(view.querySelector('video')).toBeNull();
    expect(view.querySelector('li a')?.textContent).toBe('Video');
  });

  it('names one no browser plays by what it is too, rather than by its media id', () => {
    const amr = { ...note, filename: '1011360668584057.amr', contentType: 'audio/amr' };
    expect(draw([amr]).querySelector('li a')?.textContent).toBe('Audio');
  });

  it('names a voice clip it cannot play as sound, though it arrives as a video', () => {
    const view = draw([clip], new Map([[clip.id, 'sound']]));
    expect(view.querySelector('li a')?.textContent).toBe('Audio');
  });

  it('draws a video it can play at once, fetching only its metadata', () => {
    const video = draw([webm]).querySelector('video');
    expect(video?.getAttribute('preload')).toBe('metadata');
    expect(video?.className).toContain('max-h-80');
  });

  it('draws a Messenger voice clip as a voice note: a bar, fetched on play, named as sound', () => {
    const view = draw([webm], new Map([[webm.id, 'sound']]));
    const video = view.querySelector('video');
    expect(video?.getAttribute('preload')).toBe('none');
    expect(video?.className).toContain('h-12');
    expect(video?.getAttribute('aria-label')).toBe('Audio, 146 KB');
  });

  it('keeps a sticker small', () => {
    const view = draw([{ ...photo, contentType: 'image/webp' }], new Map([[photo.id, 'sticker']]));
    expect(view.querySelector('a')!.className).toContain('size-40');
  });
});
