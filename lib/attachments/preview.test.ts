import { describe, expect, it } from 'vitest';
import { isPreviewableImage, playableMedia } from './preview';

describe('isPreviewableImage', () => {
  it('accepts what channels actually send photographs as', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(isPreviewableImage(type)).toBe(true);
    }
  });

  it('reads a MIME part label regardless of its parameters and case', () => {
    expect(isPreviewableImage('image/jpeg; name="IMG_0412.jpg"')).toBe(true);
    expect(isPreviewableImage('IMAGE/PNG')).toBe(true);
    expect(isPreviewableImage(' image/jpg ')).toBe(true);
  });

  it('leaves an image most browsers cannot decode as a link', () => {
    expect(isPreviewableImage('image/heic')).toBe(false);
    expect(isPreviewableImage('image/heif')).toBe(false);
    expect(isPreviewableImage('image/tiff')).toBe(false);
  });

  it('leaves an SVG as a link, since the preview opens the original in a tab', () => {
    expect(isPreviewableImage('image/svg+xml')).toBe(false);
  });

  it('does not guess from a type that says nothing', () => {
    expect(isPreviewableImage('application/octet-stream')).toBe(false);
    expect(isPreviewableImage('')).toBe(false);
    expect(isPreviewableImage('application/pdf')).toBe(false);
  });
});

describe('playableMedia', () => {
  it('offers what channels record as media to the browser, asking about voice notes as Opus', () => {
    expect(playableMedia('audio/ogg')).toEqual({
      kind: 'audio',
      probe: 'audio/ogg; codecs="opus"',
    });
    expect(playableMedia('audio/ogg; codecs=opus')?.kind).toBe('audio');
    expect(playableMedia('VIDEO/MP4')).toEqual({
      kind: 'video',
      probe: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    });
    expect(playableMedia('audio/x-m4a')?.probe).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(playableMedia('audio/mp4')?.probe).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(playableMedia('video/quicktime')?.probe).toBe(
      'video/quicktime; codecs="avc1.42E01E, mp4a.40.2"',
    );
  });

  it('keeps what no browser plays as a download link', () => {
    expect(playableMedia('audio/amr')).toBeNull();
    expect(playableMedia('video/3gpp')).toBeNull();
    expect(playableMedia('image/jpeg')).toBeNull();
    expect(playableMedia('__proto__')).toBeNull();
  });
});
