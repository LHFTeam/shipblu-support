import { describe, expect, it } from 'vitest';
import { previewText } from './preview';
import { PREVIEW_CHARS } from './schemas';

describe('previewText', () => {
  it('keeps a short text whole', () => {
    expect(previewText('Where is my parcel?')).toBe('Where is my parcel?');
    expect(previewText('x'.repeat(PREVIEW_CHARS))).toHaveLength(PREVIEW_CHARS);
  });

  it('cuts at 140 UTF-16 code units', () => {
    expect(previewText('ب'.repeat(200))).toBe('ب'.repeat(140));
  });

  // Half a character is a lone surrogate, which JSON carries only escaped and
  // a list row draws as a replacement mark.
  it('stops one short rather than split a surrogate pair', () => {
    const text = `${'x'.repeat(139)}🚚 and more`;
    const cut = previewText(text);
    expect(cut).toBe('x'.repeat(139));
    expect(previewText(`${'x'.repeat(138)}🚚 and more`)).toBe(`${'x'.repeat(138)}🚚`);
  });
});
