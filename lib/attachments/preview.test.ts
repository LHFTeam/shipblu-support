import { describe, expect, it } from 'vitest';
import { isPreviewableImage } from './preview';

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
