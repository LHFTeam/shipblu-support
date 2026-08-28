/**
 * What Messenger reports about a person, in the vocabulary this system stores.
 *
 * Pure and separate from `lib/meta/client.ts` because Graph answers with
 * Facebook's own gender values and what to do with one neither of us has a name
 * for is a decision worth asserting in a test rather than burying in the middle
 * of a fetch.
 *
 * The locale needs no such narrowing. It is stored exactly as Graph sends it,
 * on `contact_identities.profile_locale`, and deliberately never copied into
 * `contacts.locale` — see `worker/handlers/fetch-meta-profile.ts` for why a
 * Facebook interface language must not become the language we answer in.
 *
 * Instagram has neither field. Only the Messenger User Profile API offers
 * `locale` and `gender`, and each is gated behind its own permission
 * (`pages_user_locale`, `pages_user_gender`) on top of Business Asset User
 * Profile Access — see `profileFields`.
 */

/**
 * The genders Graph actually returns for a person who has set one.
 *
 * Meta documents `male` and `female` and omits the field entirely for anyone
 * who has not chosen, or who has chosen a custom gender it will not disclose to
 * an app. So there is no third value to map — an unrecognised string is stored
 * as null rather than passed through, because this column is displayed to
 * agents and a raw Graph token nobody has seen before is worse than a blank.
 */
const KNOWN_GENDERS = new Set(['male', 'female']);

export function normaliseGender(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;

  return KNOWN_GENDERS.has(value) ? value : null;
}
