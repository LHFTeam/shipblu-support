import { describe, expect, it } from 'vitest';
import { isForeignKeyViolation, isUniqueViolation } from './errors';

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

describe('isForeignKeyViolation', () => {
  const driver = {
    code: '23503',
    constraint_name: 'kb_article_stats_article_id_kb_articles_id_fk',
  };

  it('reads the code on the error or on its cause, and the constraint when named', () => {
    const wrapped = Object.assign(new Error('Failed query'), { cause: driver });
    expect(isForeignKeyViolation(driver)).toBe(true);
    expect(isForeignKeyViolation(wrapped, 'kb_article_stats_article_id_kb_articles_id_fk')).toBe(
      true,
    );
    expect(isForeignKeyViolation(wrapped, 'kb_article_feedback_article_id_kb_articles_id_fk')).toBe(
      false,
    );
  });

  it('is false for a unique violation, and for what is not an error at all', () => {
    expect(isForeignKeyViolation({ code: '23505' })).toBe(false);
    expect(isForeignKeyViolation(new Error('connection lost'))).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
  });
});
