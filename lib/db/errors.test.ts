import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors';

describe('isUniqueViolation', () => {
  const driver = { code: '23505', constraint_name: 'channels_name_idx' };

  // postgres.js throws its own error; drizzle wraps it with the driver's as
  // `cause`. Each caller meets one or the other depending on how it wrote.
  it('reads the code on the error or on its cause', () => {
    expect(isUniqueViolation(driver)).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error('Failed query'), { cause: driver }))).toBe(
      true,
    );
  });

  it('names the constraint only when asked to', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: driver });
    expect(isUniqueViolation(wrapped, 'channels_name_idx')).toBe(true);
    expect(isUniqueViolation(wrapped, 'agents_email_idx')).toBe(false);
  });

  it('is false for any other failure, and for what is not an error at all', () => {
    expect(isUniqueViolation({ code: '23503', constraint_name: 'channels_name_idx' })).toBe(false);
    expect(isUniqueViolation(new Error('connection lost'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});
