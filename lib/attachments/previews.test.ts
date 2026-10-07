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
});
