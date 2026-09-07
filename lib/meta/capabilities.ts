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

import type { MetaConnection } from './connection';

export type Capability = {
  /** How somebody would describe the thing they are trying to do. */
  name: string;
  /**
   * The connection whose credential this capability is a property of.
   *
   * Not decoration. Instagram appears twice in this table under two different
   * permission vocabularies — `instagram_manage_comments` through the Facebook
   * Page, `instagram_business_manage_comments` through Instagram Login — and a
   * token carrying one is *correctly* missing the other. Without this field the
   * diagnostic reports half its rows as blocked on a perfectly configured app,
   * which trains everybody to skim past it.
   */
  connection: MetaConnection;
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
    connection: 'facebook_page',
    symptom: 'Facebook DMs neither arrive nor send',
    permissions: ['pages_messaging'],
  },
  {
    name: 'Facebook comment webhooks',
    connection: 'facebook_page',
    symptom: 'no ticket is opened when somebody comments on a Page post',
    permissions: ['pages_manage_metadata', 'pages_show_list'],
  },
  {
    name: 'Facebook comment moderation',
    connection: 'facebook_page',
    symptom: 'hide, unhide and delete are refused; public replies still work',
    permissions: ['pages_read_user_content', 'pages_manage_engagement', 'pages_show_list'],
  },
  {
    name: 'Instagram direct messages (Facebook Page connection)',
    connection: 'facebook_page',
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
    name: 'Instagram comment webhooks and moderation (Facebook Page connection)',
    connection: 'facebook_page',
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
    connection: 'facebook_page',
    symptom: 'names and pictures still resolve; the two extra fields stay empty',
    permissions: ['pages_user_locale', 'pages_user_gender'],
  },
  /*
    The two rows below are narrowed to one permission each, deliberately, on
    2026-09-07: the direct connection is being tested against
    `instagram_business_manage_messages` and `instagram_business_manage_comments`
    alone, so `instagram_business_basic` is not being requested for now.

    It is a statement about what the authorisation asks for, not a claim about
    what Meta will hand over: the permission reference lists
    `instagram_business_basic` as a dependency of *both* of them, so an
    authorisation naming only these two may well come back carrying three. What
    the narrowing actually costs is one call — `GET graph.instagram.com/me` is
    `instagram_business_basic`'s and nothing else's, so `check_meta_permissions`
    can no longer confirm which account the token belongs to, and says so rather
    than reading the refusal as a dead credential. Sends and moderation are
    gated by the two permissions named here and are untouched.

    Put `instagram_business_basic` back on both rows to restore the full list.
  */
  {
    /*
      The same two capabilities again, spelled the other way.

      Not duplication: these are the permissions of a different authorisation
      against a different host, and an app connected both ways holds both sets at
      once. Reading one set's absence as the other's problem is what §6.29 did for
      a day — an `instagram_business_*` name in App Review was taken as proof of
      which connection the account was on, when in fact it only says which
      connection somebody last submitted for.
    */
    name: 'Instagram direct messages (direct connection)',
    connection: 'instagram_login',
    symptom: 'Instagram DMs arrive but every reply is refused by graph.instagram.com',
    permissions: ['instagram_business_manage_messages'],
  },
  {
    name: 'Instagram comment webhooks and moderation (direct connection)',
    connection: 'instagram_login',
    symptom: 'no ticket is opened when somebody comments on a post, while DMs still arrive',
    permissions: ['instagram_business_manage_comments'],
    advancedAccess:
      'Meta requires Advanced Access to deliver `comments` to the general public. The direct ' +
      'connection did start delivering them at Standard Access on 2026-08-30, but every ' +
      'delivery so far has been a comment left by the account on its own media — which ' +
      "Standard Access covers, and which says nothing about a customer's. Treat a public " +
      "comment arriving as the thing that settles it, not the account's own.",
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
  /**
   * Which connection's token these scopes came from.
   *
   * Rows belonging to the other connection are left out rather than reported
   * missing. A Page token is *supposed* to lack
   * `instagram_business_manage_messages`, and saying otherwise turns a correct
   * configuration into six blocked lines.
   */
  connection: MetaConnection = 'facebook_page',
): CapabilityReport[] {
  const granted = new Set(scopes);
  const refused = new Set(declined);

  return CAPABILITIES.filter((capability) => capability.connection === connection).map(
    (capability) => {
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
    },
  );
}

/**
 * Every permission the system wants, deduplicated — the scope list to request
 * when re-running an authorisation.
 *
 * Derived from the table rather than written out a second time: the failure this
 * whole module exists to prevent is a permission the code depends on that is not
 * in the list somebody pastes into a login dialog.
 */
export function requiredScopes(connection: MetaConnection = 'facebook_page'): string[] {
  return [
    ...new Set(
      CAPABILITIES.filter((capability) => capability.connection === connection).flatMap(
        (capability) => capability.permissions,
      ),
    ),
  ].sort();
}

/**
 * The gates that are **features** rather than permissions.
 *
 * Kept apart from `CAPABILITIES` because nothing above can check them and
 * pretending otherwise is the failure this exists to stop. A feature never
 * appears in `scopes` or `granular_scopes` — it is a property of the app, not of
 * the token — so `debug_token` returns a clean, complete list while the app is
 * refused, and `check_meta_permissions` prints "every capability is granted"
 * truthfully and unhelpfully. That is exactly how the Human Agent refusal read
 * from the inside on 2026-09-06.
 *
 * Two more things separate a feature from a permission, and both were assumed
 * the other way round first:
 *
 *   - **A role on the app is not the exemption it is for a permission.** Meta's
 *     own note on Standard Access: "some features might not work properly until
 *     your app has been granted Advanced Access."
 *   - **The dashboard's usage counter cannot move before the grant.** A call
 *     refused at the capability gate never reaches the feature, so it is never
 *     counted against it. A zero there is the refusal restated, not a second
 *     fault — the same reading §5.2 records for Business Asset User Profile
 *     Access.
 *
 * So this table is printed rather than diagnosed, and says so.
 */
export type Feature = {
  /** Meta's own name for it in the App Dashboard, so a search finds the row. */
  name: string;
  connection: MetaConnection;
  /** What stops working while it is ungranted. */
  symptom: string;
  /** How Graph refuses it, where that has been read out of production. */
  refusal?: string;
};

export const FEATURES: readonly Feature[] = [
  {
    name: 'Human Agent',
    connection: 'instagram_login',
    symptom:
      'every Instagram reply between 24 hours and 7 days after the customer wrote is refused; ' +
      'replies inside 24 hours still send',
    refusal:
      "code 10, HTTP 403, \"To use 'Human Agent', your use of this endpoint must be reviewed " +
      'and approved by Facebook.\" — observed 2026-09-06',
  },
  {
    name: 'Human Agent',
    connection: 'facebook_page',
    symptom:
      'every Messenger reply between 24 hours and 7 days after the customer wrote is refused; ' +
      'replies inside 24 hours still send',
  },
  {
    name: 'Business Asset User Profile Access',
    connection: 'facebook_page',
    symptom: "a Facebook or Instagram customer's name and picture never resolve",
    refusal: '(#3) Application does not have the capability to make this API call. — §5.2',
  },
];
