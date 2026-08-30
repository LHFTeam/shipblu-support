/**
 * What each Meta permission actually buys, and which of them a token is missing.
 *
 * Written after an afternoon spent reading a missing *grant* as a missing App
 * Review approval — they are different things and only one of them was ever the
 * problem here (`docs/PROJECT-STATE.md` §6.34).
 *
 * **Adding a permission to an App Review submission grants nothing.** A
 * submission asks for **Advanced Access**, which is what lets an app use a
 * permission for the general public, and it changes nothing at all until it is
 * approved. Every permission also has **Standard Access**, which needs no
 * review and works immediately — but only for people holding a role on the app
 * (admin, developer, tester) and only on assets those people administer. An
 * admin testing with their own account is exactly the case Standard Access is
 * for, so "we are waiting on App Review" is the wrong answer to "my own comment
 * did not arrive".
 *
 * What Standard Access still requires is that the permission was **asked for
 * and granted**: it has to be in the scope list of the authorisation that
 * produced the token. A permission nobody requested is not granted to anybody,
 * role holder or not, and Meta reports that as silence rather than as an error —
 * the webhook simply never fires.
 *
 * Hence this table. It is the map from a capability somebody is trying to use to
 * the permissions that have to be in that scope list, so `check_meta_permissions`
 * can name the missing one instead of leaving it to be inferred from which half
 * of a channel went quiet.
 */

export type Capability = {
  /** How somebody would describe the thing they are trying to do. */
  name: string;
  /** What is observed when it is missing — the symptom, not the mechanism. */
  symptom: string;
  permissions: readonly string[];
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
    permissions: [
      'instagram_basic',
      'instagram_manage_comments',
      'pages_read_engagement',
      'pages_show_list',
    ],
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
