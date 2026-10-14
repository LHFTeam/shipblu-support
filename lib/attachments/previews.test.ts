import { describe, expect, it } from 'vitest';
import {
  initialPreviewState,
  loadOf,
  type PreviewAction,
  type PreviewFile,
  previewReducer,
  type PreviewState,
  previewFile,
} from './previews';

const photo = { id: 'a', name: 'IMG_0412.jpg' };
const label = { id: 'b', name: 'label.webp' };

function run(...actions: PreviewAction[]): PreviewState {
  return actions.reduce(previewReducer, initialPreviewState);
}

const toggle = (file: PreviewFile = photo): PreviewAction => ({ type: 'toggle', file });
const fail = (file: PreviewFile = photo): PreviewAction => ({
  type: 'settle',
  file,
  load: 'failed',
});
const load = (file = photo): PreviewAction => ({ type: 'settle', file, load: 'loaded' });
const retry = (file = photo): PreviewAction => ({ type: 'retry', file });

describe('previewReducer', () => {
  it('reads a picture that has not settled yet as loading, opened or not', () => {
    expect(loadOf(run(), photo.id)).toBe('loading');
    expect(loadOf(run(toggle()), photo.id)).toBe('loading');
  });

  it('keeps a closed preview known, so it stays mounted and is not fetched again', () => {
    const state = run(toggle(), load(), toggle());
    expect(state.showing).toEqual({ a: false });
    expect(loadOf(state, photo.id)).toBe('loaded');
  });

  it('says nothing about a picture that loads', () => {
    expect(run(toggle(), load()).notice).toBeNull();
  });

  it('announces a failure while the preview is showing, naming what to do next', () => {
    expect(run(toggle(), fail()).notice?.text).toBe(
      'IMG_0412.jpg could not be shown here. Try again, or open the file.',
    );
  });

  it('holds a failure behind a closed preview until it is opened', () => {
    const hidden = run(toggle(), toggle(), fail());
    expect(hidden.notice).toBeNull();

    const reopened = previewReducer(hidden, toggle());
    expect(reopened.notice?.fileId).toBe(photo.id);
  });

  it('announces a reopened failure again with a new seq, so the region changes', () => {
    const first = run(toggle(), fail());
    const again = run(toggle(), fail(), toggle(), toggle());
    expect(again.notice?.text).toBe(first.notice?.text);
    expect(again.notice?.seq).not.toBe(first.notice?.seq);
  });

  it('withdraws a notice once it stops being true', () => {
    expect(run(toggle(), fail(), retry()).notice).toBeNull();
    expect(run(toggle(), fail(), toggle()).notice).toBeNull();
    expect(loadOf(run(toggle(), fail(), retry()), photo.id)).toBe('loading');
  });

  it('announces a retry that fails again as a fresh notice', () => {
    const first = run(toggle(), fail());
    const second = run(toggle(), fail(), retry(), fail());
    expect(second.notice?.fileId).toBe(photo.id);
    expect(second.notice?.seq).toBeGreaterThan(first.notice!.seq);
  });

  it('announces a voice note’s failure at once, since its player was never closed', () => {
    const note = { id: 'n', name: 'Audio, 21 KB', kind: 'audio' as const };
    const state = run({ type: 'settle', file: note, load: 'failed' });
    expect(state.notice?.text).toBe(
      'Audio, 21 KB could not be played here. Try again, or open the file.',
    );
  });

  it('says a video could not be played, not shown', () => {
    const clip = { id: 'v', name: 'Video, 2.3 MB', kind: 'video' as const };
    expect(run(toggle(clip), fail(clip)).notice?.text).toMatch(
      /^Video, 2\.3 MB could not be played/,
    );
  });

  it('leaves another picture’s notice alone', () => {
    const state = run(toggle(photo), toggle(label), fail(label), load(photo), toggle(photo));
    expect(state.notice?.fileId).toBe(label.id);
  });
});

describe('previewReducer, for files the thread loads by itself', () => {
  const picture = { id: 'p', name: 'Picture, 86 KB', kind: 'image' as const, loadsItself: true };
  const clip = { id: 'c', name: 'Video, 1 MB', kind: 'video' as const, loadsItself: true };

  it('leaves a failure nobody asked for as the line on screen', () => {
    // Every picture on the ticket failing together — Storage down — is not
    // read out picture by picture as the ticket opens.
    expect(run(fail(picture)).notice).toBeNull();
    expect(run(fail(clip)).notice).toBeNull();
    expect(loadOf(run(fail(picture)), picture.id)).toBe('failed');
  });

  it('announces a failure that answers "Try again"', () => {
    expect(run(fail(picture), retry(picture), fail(picture)).notice?.text).toBe(
      'Picture, 86 KB could not be shown here. Try again, or open the file.',
    );
  });

  it('announces a player’s failure that follows play', () => {
    const state = run({ type: 'settle', file: clip, load: 'failed', pressed: true });
    expect(state.notice?.text).toMatch(/^Video, 1 MB could not be played/);
  });

  it('withdraws the notice once the retry loads', () => {
    expect(
      run(fail(picture), retry(picture), fail(picture), retry(picture), load(picture)).notice,
    ).toBeNull();
  });
});

describe('previewFile', () => {
  const stored = { id: 'f', filename: '1011360668584057.ogg', sizeBytes: 21_504 };

  it('names a player by what it is, never by the media id it is stored under', () => {
    expect(previewFile(stored, 'audio').name).toBe('Audio, 21 KB');
    expect(previewFile({ ...stored, sizeBytes: 2_411_725 }, 'video').name).toBe('Video, 2.3 MB');
  });

  it('names a picture, and a file shown only as a link, by its file name', () => {
    expect(previewFile({ ...stored, filename: 'IMG_0412.jpg' }, 'image').name).toBe('IMG_0412.jpg');
    expect(previewFile(stored, undefined).name).toBe('1011360668584057.ogg');
  });

  it('names a picture in the thread by what it is, as it has no chip to be named after', () => {
    const photo = { ...stored, filename: '1002979522811778.jpg', sizeBytes: 88_064 };
    expect(previewFile(photo, 'image', { inline: true })).toEqual({
      id: 'f',
      name: 'Picture, 86 KB',
      kind: 'image',
      loadsItself: true,
    });
  });

  it('names a sticker in the thread as one', () => {
    const sticker = { ...stored, filename: '1056976047212813.webp', sizeBytes: 12_288 };
    expect(previewFile(sticker, 'image', { inline: true, sticker: true }).name).toBe(
      'Sticker, 12 KB',
    );
  });

  it('marks only what fetches unasked as loading by itself', () => {
    expect(previewFile(stored, 'video', { inline: true }).loadsItself).toBe(true);
    // A voice note fetches nothing until play.
    expect(previewFile(stored, 'audio', { inline: true }).loadsItself).toBeUndefined();
    expect(previewFile(stored, undefined, { inline: true }).loadsItself).toBeUndefined();
    expect(previewFile(stored, 'image').loadsItself).toBeUndefined();
  });
});
