/**
 * The locale every contact starts at, whether or not anybody knows.
 *
 * `contacts.locale` is `not null default 'en'`, so 'en' means either "this
 * person reads English" or "nobody has ever said" — and those are different
 * facts that the column cannot tell apart. Everything that writes it treats the
 * value as the second: a merge can adopt the loser's locale but never replace a
 * locale that was actually chosen, and a Messenger profile can fill it in but
 * never overwrite one.
 *
 * Its own module because it now has two callers with the same rule — the merge
 * and `applyChannelProfile` — and a constant that decides whether a customer is
 * written to in Arabic is not one to keep two copies of.
 *
 * Deliberately *not* `DEFAULT_LOCALE` from `lib/kb/locale.ts`, which is 'ar'.
 * That one is where an unprefixed help-centre URL lands, and it is Arabic
 * because the front door should open in the language most customers read. This
 * one is a column default that predates it and means "unset". They disagree on
 * purpose; collapsing them would silently mark every contact in the system as
 * an Arabic speaker.
 */
export const DEFAULT_CONTACT_LOCALE = 'en';
