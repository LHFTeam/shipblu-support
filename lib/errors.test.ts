import { describe, expect, it } from 'vitest';
import { errorMessage, gotNoAnswer } from './errors';

describe('gotNoAnswer', () => {
  it('knows the admission gate’s give-up and a cancel, bare or wrapped by drizzle', () => {
    const gaveUp = Object.assign(new Error('given up'), { code: '57014' });
    expect(gotNoAnswer(gaveUp)).toBe(true);
    expect(gotNoAnswer(new Error('Failed query', { cause: gaveUp }))).toBe(true);
  });

  it('leaves every other failure, a refusal by Postgres included, to be handled', () => {
    const refused = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    expect(gotNoAnswer(refused)).toBe(false);
    expect(gotNoAnswer(new Error('Failed query', { cause: refused }))).toBe(false);
    expect(gotNoAnswer(new TypeError('not a function'))).toBe(false);
    expect(gotNoAnswer('57014')).toBe(false);
    expect(gotNoAnswer(undefined)).toBe(false);
  });
});

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
