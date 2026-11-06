/**
 * Whether a write was refused by a unique index (23505), and, given
 * `constraint`, by that one.
 *
 * Where Postgres's code sits depends on who threw: postgres.js puts it on the
 * error itself, and drizzle wraps that in an error of its own with the driver's
 * as `cause`. Both are read, one level deep, which is as deep as either goes
 * today. This is the one copy, so a change in that wrapping is found once.
 *
 * Name the constraint wherever the sentence the caller answers with names what
 * clashed: a table with more than one unique index would otherwise report the
 * wrong one.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return hasCode(error, '23505', constraint);
}

/**
 * Whether a write was refused by a foreign key (23503), and, given
 * `constraint`, by that one. Read as `isUniqueViolation` reads its code.
 *
 * For a write that is allowed to lose a race with the row it points at being
 * deleted, where answering as though the delete came first is the honest
 * outcome. Name the constraint, so a write refused for pointing somewhere else
 * still throws.
 */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  return hasCode(error, '23503', constraint);
}

function hasCode(error: unknown, code: string, constraint: string | undefined): boolean {
  const cause = isObject(error) ? error.cause : undefined;
  return [error, cause].some(
    (candidate) =>
      isObject(candidate) &&
      candidate.code === code &&
      (constraint === undefined || candidate.constraint_name === constraint),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
