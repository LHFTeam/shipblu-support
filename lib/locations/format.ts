/**
 * Canonical form for a location's code.
 *
 * A code is typed by people, in tickets and on paper, so it arrives as `CAI-1`,
 * `cai 1`, `CAI_1` and ` cai-1 ` — all meaning one hub. Normalising to a single
 * shape before every write and lookup is what lets `locations_code_idx` be a
 * plain unique index rather than an expression one, and it is the same
 * discipline `contact_identities` and agent emails already rely on.
 *
 * Uppercase, one hyphen as the only separator, no leading or trailing
 * separators. Underscores and spaces become hyphens rather than being rejected:
 * the alternative is an error message about punctuation for two strings nobody
 * would read as different codes.
 */
export function normaliseLocationCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Longer than any code worth typing, short enough to fit a table column. */
export const LOCATION_CODE_MAX = 16;
const LOCATION_CODE_MIN = 2;

const CODE_SHAPE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/**
 * Whether a normalised code is usable.
 *
 * Deliberately strict about the character set and permissive about meaning: we
 * do not know ShipBlu's naming scheme and must not invent one, so anything
 * alphanumeric with hyphens passes. What it rejects is the shapes that would
 * make a code useless as an identifier — empty, punctuation-only, or long
 * enough to be a sentence.
 *
 * Takes the raw value and normalises first, so a caller cannot check one string
 * and store another.
 */
export function isValidLocationCode(code: string): boolean {
  const canonical = normaliseLocationCode(code);
  return (
    canonical.length >= LOCATION_CODE_MIN &&
    canonical.length <= LOCATION_CODE_MAX &&
    CODE_SHAPE.test(canonical)
  );
}
