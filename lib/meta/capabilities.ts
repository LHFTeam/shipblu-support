/**
 * What each Meta permission actually buys, and which of them a token is missing.
 *
 * Two different things gate a Meta capability and they are constantly confused
 * here — this table exists so `check_meta_permissions` can name which one is
 * actually in the way (`docs/PROJECT-STATE.md` §6.34).
 *
 * **The grant.** The permission has to be in the scope list of the
 * authorisation that minted the token. A permission nobody requested is granted
 * to nobody, and Meta reports that as silence rather than as an error.
 *
 * **The access level.** Every permission has **Standard Access**, which needs no
 * review but works only for people holding a role on the app (admin, developer,
 * tester) on assets they administer, and **Advanced Access**, which reaches the
 * general public and is what an App Review submission asks for.
 *
 * For nearly everything here, an admin testing on their own account is covered
 * by Standard Access and App Review is irrelevant until launch. **The Instagram
 * `comments` webhook is the documented exception**, and it is worth stating
 * flatly because assuming the general rule cost a day: Meta requires *Advanced
 * Access* to receive `comments` and `live_comments` notifications at all. An app
 * admin commenting on their own public post gets nothing until the submission is
 * approved. That is why the account can have DMs working — `instagram_manage_
 * messages` is fine at Standard Access for a role holder — while comments stay
 * silent no matter how the token is regenerated.
 *
 *   "Your app must have successfully completed App Review (advanced access) to
 *    receive webhooks notifications for comments and live_comments webhooks
 *    fields."
 *
 * `advancedAccess` marks the rows where that applies, so a granted-but-silent
 * permission is diagnosed rather than re-debugged.
 */

export type Capability = {
  /** How somebody would describe the thing they are trying to do. */
  name: string;
  /** What is observed when it is missing — the symptom, not the mechanism. */
  symptom: string;
  permissions: readonly string[];
  /**
   * Set where Meta requires Advanced Access, i.e. an approved App Review
   * submission, even for a role holder on their own assets. The string is the
   * reason, printed beside the grant so "every permission is granted and it is
   * still silent" is a diagnosis rather than the start of another search.
   */
  advancedAccess?: string;
};

/**
 * Ordered so the two halves of each channel sit together, because the diagnosis
 * that matters most is "messages work and comments do not" and that reads
 * directly off adjacent rows.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    name: 'Messenger direct messages',
    symptom: 'Facebook DMs neither arrive nor send',
    permissions: ['pages_messaging'],
  },
  {
    name: 'Facebook comment webhooks',
    symptom: 'no ticket is opened when somebody comments on a Page post',
    permissions: ['pages_manage_metadata', 'pages_show_list'],
  },
  {
    name: 'Facebook comment moderation',
    symptom: 'hide, unhide and delete are refused; public replies still work',
    permissions: ['pages_read_user_content', 'pages_manage_engagement', 'pages_show_list'],
  },
  {
    name: 'Instagram direct messages',
    symptom: 'Instagram DMs neither arrive nor send',
    permissions: ['instagram_basic', 'instagram_manage_messages'],
  },
  {
    /*
      The one that gates *delivery* and not merely moderation, which is the
      asymmetry that makes this table worth having: Facebook's comment webhook
      needs only the two Page permissions above, both of which any working
      Messenger setup already holds, so `feed` starts arriving on its own. The
      `comments` field does not — without `instagram_manage_comments` Meta sends
      nothing, and the account looks identical to one nobody has commented on.
    */
    name: 'Instagram comment webhooks and moderation',
    symptom: 'no ticket is opened when somebody comments on a post, while DMs still arrive',
    // Meta's list for Instagram API with Facebook Login, verbatim.
    permissions: [
      'instagram_basic',
      'instagram_manage_comments',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_show_list',
    ],
    advancedAccess:
      'Meta requires Advanced Access to deliver `comments` at all — an approved App Review ' +
      'submission. Standard Access does not cover this one even for an app admin on their own ' +
      'public post, which is why regenerating the token changes nothing.',
  },
  {
    name: "Customer's locale and gender on the contact",
    symptom: 'names and pictures still resolve; the two extra fields stay empty',
    permissions: ['pages_user_locale', 'pages_user_gender'],
  },
];

/** What Meta says about one permission. `missing` is our word, not Meta's. */
export type PermissionStatus = 'granted' | 'declined' | 'missing';

export type CapabilityReport = {
  capability: Capability;
  /** Every permission this capability needs, with what the token says about it. */
  permissions: { permission: string; status: PermissionStatus }[];
  blocked: boolean;
};

/**
 * Each capability against the scopes a token actually carries.
 *
 * `granted` comes from Meta; anything absent from the list is reported `missing`
 * rather than `declined`, and the distinction is the useful part. **Declined
 * means somebody unticked it in the login dialog. Missing means it was never in
 * the dialog at all** — a different fix, in a different place: declined is
 * re-authorising and accepting, missing is changing what the authorisation asks
 * for before re-running it.
 */
export function diagnoseCapabilities(
  scopes: Iterable<string>,
  declined: Iterable<string> = [],
): CapabilityReport[] {
  const granted = new Set(scopes);
  const refused = new Set(declined);

  return CAPABILITIES.map((capability) => {
    const permissions = capability.permissions.map((permission) => ({
      permission,
      status: granted.has(permission)
        ? ('granted' as const)
        : refused.has(permission)
          ? ('declined' as const)
          : ('missing' as const),
    }));

    return {
      capability,
      permissions,
      blocked: permissions.some((entry) => entry.status !== 'granted'),
    };
  });
}

/**
 * Every permission the system wants, deduplicated — the scope list to request
 * when re-running an authorisation.
 *
 * Derived from the table rather than written out a second time: the failure this
 * whole module exists to prevent is a permission the code depends on that is not
 * in the list somebody pastes into a login dialog.
 */
export function requiredScopes(): string[] {
  return [...new Set(CAPABILITIES.flatMap((capability) => capability.permissions))].sort();
}
