import { describe, expect, it } from 'vitest';
import { mimeEssence } from './mime';

describe('mimeEssence', () => {
  it('drops the parameters a MIME part carries', () => {
    expect(mimeEssence('image/jpeg; name="IMG_0412.jpg"')).toBe('image/jpeg');
    expect(mimeEssence('text/plain;charset=utf-8')).toBe('text/plain');
  });

  it('folds case and surrounding space', () => {
    expect(mimeEssence(' IMAGE/PNG ')).toBe('image/png');
  });

  it('answers empty for a type nobody guessed', () => {
    expect(mimeEssence('')).toBe('');
    expect(mimeEssence(null)).toBe('');
    expect(mimeEssence(undefined)).toBe('');
    expect(mimeEssence('; name=x')).toBe('');
  });
});
