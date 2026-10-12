import { describe, expect, it } from 'vitest';
import { sentenceCase } from './format';

describe('sentenceCase', () => {
  it('capitalises the first letter and spaces every underscore', () => {
    expect(sentenceCase('published')).toBe('Published');
    expect(sentenceCase('agents_only')).toBe('Agents only');
    expect(sentenceCase('account_admin_role')).toBe('Account admin role');
  });

  it('leaves an empty string empty', () => {
    expect(sentenceCase('')).toBe('');
  });
});
