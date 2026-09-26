import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors';

describe('errorMessage', () => {
  it('reads the message off an Error, subclasses included', () => {
    expect(errorMessage(new Error('connection reset'))).toBe('connection reset');
    expect(errorMessage(new TypeError('not a function'))).toBe('not a function');
  });

  it('stringifies anything else that was thrown', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(503)).toBe('503');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage({ code: 100 })).toBe('[object Object]');
  });
});
