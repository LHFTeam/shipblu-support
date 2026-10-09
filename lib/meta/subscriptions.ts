import { env, metaAppSecret, metaVerifyToken } from '@/lib/env';
import { isTimeout } from '@/lib/http/deadline';
import { GRAPH_BASE, graphTimeout, INSTAGRAM_GRAPH_BASE } from './graph';
import { errorMessage } from '@/lib/errors';

/**
 * The app's own webhook field subscriptions.
 *
 * Separate from `lib/meta/client` and `lib/whatsapp/client` even though all
 * three talk to graph.facebook.com, because this one is addressed and
 * authenticated differently from both: the endpoint is `/{app-id}/subscriptions`
 * rather than a page or phone number, and it takes an *app* access token, which
 * the page token cannot stand in for.
 *
 * This is configuration, not traffic. Its writes run from `npm run job --
 * subscribe_meta_webhooks` and nowhere else, which is why nothing here retries:
 * a person is watching the output, and a failure they can read beats a retry
 * that hides which half of a two-step change actually landed. The one other
 * caller only reads: `complete_coexistence_onboarding` calls
 * `readSubscription` to name the WhatsApp fields a Business-app number needs
 * and the app is not subscribed to, which it cannot fix for itself.
 *
 * **A webhook has two subscriptions, not one, and this module writes both.**
 * Meta's own sentence is that "only fields with subscriptions at both the page
 * and app levels will get Webhooks": `POST /{app-id}/subscriptions` says which
 * fields the *app* wants, and an account-level write says which fields that
 * account sends. Only the first was ever implemented, and the second is the
 * reason `feed` had never delivered a single event — 0 of 4,503 `page` and
 * `instagram` deliveries carried a `changes` entry.
 *
 * The account-level half is where the two Instagram connections part company,
 * and there are three writes in this file rather than two because of it:
 *
 *   app level          POST graph.facebook.com/{app-id}/subscriptions      app token
 *   Facebook Page      POST graph.facebook.com/{page-id}/subscribed_apps   Page token
 *   direct Instagram   POST graph.instagram.com/{ig-id}/subscribed_apps    Instagram token
 *
 * The app level is shared: one app, one `instagram` object subscription, serving
 * both connections. Each connection then owns its own account-level half, with a
 * different host, a different credential and — for the Page — a different field
 * vocabulary.
 */

/** The Webhooks objects this app subscribes to, one per product. */
export const WHATSAPP_OBJECT = 'whatsapp_business_account';
export const INSTAGRAM_OBJECT = 'instagram';
export const PAGE_OBJECT = 'page';

/**
 * The `whatsapp_business_account` fields a number on the WhatsApp Business app
 * needs beyond `messages`: its chat history and contacts as they are copied,
 * the replies typed on the phone, and the number being disconnected from the
 * phone and reconnected. The first three are the coexistence guide's step 1;
 * `account_update` is the reconnect guide's, which needs it to see a number
 * offboarded and re-onboarded. All four are spelled as the webhooks overview's
 * field table spells them.
 *
 * Their own list as well as part of the required one, because the onboarding
 * job reads the app's subscription and names which of these are missing — the
 * one thing it cannot fix for itself, since this job is hand-run.
 */
export const COEXISTENCE_WHATSAPP_FIELDS = [
  'history',
  'smb_app_state_sync',
  'smb_message_echoes',
  'account_update',
] as const;

/**
 * What the WhatsApp pipeline needs delivered.
 *
 * `messages` carries inbound customer messages *and* delivery statuses, so it is
 * the field the whole channel rests on — it is listed because this job rewrites
 * the field list wholesale and the merge must be able to prove it is still
 * present, not because anything expects it to be missing.
 *
 * The coexistence fields are here because a number can now be operated from
 * the WhatsApp Business app and Cloud API at once, and each carries something
 * nothing else does: `smb_message_echoes` the business's replies typed on the
 * phone, `history` and `smb_app_state_sync` the copy of the phone's chats and
 * contacts, `account_update` the phone disconnecting. This list used to argue
 * the opposite — `smb_message_echoes` had been subscribed throughout and
 * produced 0 of 395,391 stored deliveries, which was the evidence that no
 * number was operated from the phone. That was true until coexistence, and is
 * exactly what connecting one changes.
 *
 * **A field list is not a wish list.** The job is the only way this repo writes
 * a subscription, so a name Graph rejects makes *every* run fail at the write —
 * including one somebody starts for a different channel. `message_echoes` is the
 * precedent: Meta discontinued it, Graph refused a write naming it with "An
 * unknown error occurred", and it was removed (2026-09-21; absent from the v23.0
 * reference, the version `GRAPH_VERSION` names). `smb_message_echoes` is proven
 * on this app by already being subscribed; the other three are in the webhooks
 * overview's field table, and the first run after this list grew is on staging
 * for that reason.
 */
export const REQUIRED_WHATSAPP_FIELDS = ['messages', ...COEXISTENCE_WHATSAPP_FIELDS] as const;

/**
 * What the Instagram pipeline needs delivered.
 *
 * `comments` is the field this whole feature rests on and **it has never been
 * subscribed**: of 2,854 Meta deliveries stored since 19 August, not one carries
 * a `changes` entry, so `ingestMetaComment` — written, tested and merged with the
 * channel — has never run once in production. A comment ticket cannot exist
 * until this is added, which makes it the first step of demonstrating comment
 * management to App Review rather than a nicety.
 *
 * `messages` is listed for the same reason it is under WhatsApp: the write
 * replaces the field list wholesale, so the merge must be able to prove the
 * channel's existing traffic survives.
 *
 * `live_comments` and `mentions` are deliberately absent. Both would deliver
 * events nothing ingests, and an unread webhook field is not free — it is a
 * `webhook_events` row and a job per event, forever.
 *
 * `messaging_postbacks`, `messaging_referral` and `message_reactions` are the
 * three ways a customer touches a thread without writing in it — a button, an
 * arrival from an ad or an m.me link, and a reaction. Meta's messaging policy
 * counts all three alongside a message as things that open the standard 24-hour
 * window, and `lib/meta/parse.ts` dropped every one of them until they were
 * ingested, which is why they are only being subscribed now: an unread webhook
 * field is a `webhook_events` row and a job per event, forever. They are read by
 * `applyMetaInteraction`, which writes a timeline event and — for the two that
 * mean the customer is asking for something — moves the window.
 *
 * The same two *message* names serve both Instagram connections, which is not a
 * coincidence worth relying on elsewhere: `messages` and `comments` are spelled
 * identically in the Instagram Login vocabulary and in the app-level Instagram
 * one. The Page's vocabulary is a different matter entirely — it has no
 * `comments` at all — which is why `REQUIRED_PAGE_FIELDS` is a separate list and
 * not a reuse of this one. **And the referral field is not spelled the same on
 * the two**: Instagram's is `messaging_referral` and the Page's is
 * `messaging_referrals`. One character, in the vocabulary difference §6.35 is
 * about, and Graph rejects the whole write rather than the one bad name — so the
 * two lists below cannot be folded together however similar they look.
 */
export const REQUIRED_INSTAGRAM_FIELDS = [
  'messages',
  'comments',
  'messaging_postbacks',
  'messaging_referral',
  'message_reactions',
] as const;

/**
 * What the Facebook Page pipeline needs delivered.
 *
 * `feed` rather than a comments field, because Facebook has none: the same field
 * carries comments, likes, shares and post edits, discriminated by `value.item`.
 * `lib/meta/parse.ts` keeps the comments and drops the rest, which is the cost
 * of the only field Meta offers.
 */
export const REQUIRED_PAGE_FIELDS = [
  'messages',
  'feed',
  'messaging_postbacks',
  // Plural here and singular on Instagram. See the note above
  // `REQUIRED_INSTAGRAM_FIELDS`; this is not a typo either way round.
  'messaging_referrals',
  'message_reactions',
] as const;

/**
 * Object → the fields that object must carry.
 *
 * A map rather than an argument the caller composes, because the caller is a
 * command line: `npm run job -- subscribe_meta_webhooks object=instagram` names
 * the product, and what that product needs is a property of this codebase rather
 * than something to be typed correctly at a shell prompt against production.
 */
export const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  [WHATSAPP_OBJECT]: REQUIRED_WHATSAPP_FIELDS,
  [INSTAGRAM_OBJECT]: REQUIRED_INSTAGRAM_FIELDS,
  [PAGE_OBJECT]: REQUIRED_PAGE_FIELDS,
};

/** The object named on the job, or the error naming the three that exist. */
export function resolveObject(value: unknown): string {
  const object = typeof value === 'string' && value ? value : WHATSAPP_OBJECT;

  if (!REQUIRED_FIELDS[object]) {
    throw new GraphSubscriptionError(
      `"${object}" is not a webhook object this app subscribes to. ` +
        `Pass one of: ${Object.keys(REQUIRED_FIELDS).join(', ')}.`,
    );
  }

  return object;
}

export type GraphSubscription = {
  object: string;
  callback_url: string;
  active: boolean;
  fields: { name: string; version?: string }[];
};

export class GraphSubscriptionError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: number | null = null,
    readonly traceId: string | null = null,
  ) {
    super(message);
    this.name = 'GraphSubscriptionError';
  }
}

/**
 * One request and the body it answers with, under one deadline.
 *
 * A deadline because every caller runs in a job, and nothing else frees the
 * worker slot a request with no answer holds — see `graphTimeout`. The body is
 * read inside it because the signal governs the read too, and a deadline passing
 * mid-body rejects with the signal's own reason, which names no host. None of
 * these calls is a message to a customer, so a write whose answer was lost is
 * simply failed and run again: subscribing twice is the same subscription.
 */
async function exchange(
  host: string,
  url: URL,
  method: 'GET' | 'POST',
  token: string,
): Promise<{ response: Response; text: string }> {
  const timeoutMs = graphTimeout(method);
  try {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { response, text: await response.text() };
  } catch (error) {
    throw new GraphSubscriptionError(
      isTimeout(error)
        ? `${host} did not answer in ${timeoutMs / 1000}s`
        : `${host} unreachable: ${errorMessage(error)}`,
    );
  }
}

/**
 * A request to one node, answered and parsed, or refused as a subscription
 * error.
 *
 * Each of the three levels below resolves its own credential and names its own
 * node, because those are what differ between them. What a refusal most likely
 * means differs too, and Graph's own sentence rarely says, so a level that knows
 * passes it as `explain` — after Graph's message, never instead of it.
 */
async function request<T>(
  host: string,
  node: string,
  token: string,
  init: { method: 'GET' | 'POST'; query?: Record<string, string> },
  explain: string | null = null,
): Promise<T> {
  const url = new URL(node);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const { response, text } = await exchange(host, url, init.method, token);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
    const message = typeof error.message === 'string' ? error.message : `HTTP ${response.status}`;

    throw new GraphSubscriptionError(
      explain === null ? message : `${message}\n\n${explain}`,
      response.status,
      typeof error.code === 'number' ? error.code : null,
      typeof error.fbtrace_id === 'string' ? error.fbtrace_id : null,
    );
  }

  return body as T;
}

/**
 * `{app-id}|{app-secret}`, Meta's app access token, and the app id it is built
 * from.
 *
 * Built here rather than stored as a fourth credential: it is a pure function of
 * two values we already hold, and a stored copy is one more thing to miss when
 * the secret is rotated.
 */
function appCredentials(): { appId: string; token: string } {
  const appId = env().META_APP_ID;
  const appSecret = metaAppSecret();

  if (!appId || !appSecret) {
    const missing = [!appId && 'META_APP_ID', !appSecret && 'META_APP_SECRET'].filter(Boolean);
    throw new GraphSubscriptionError(
      `${missing.join(' and ')} must be set in the shipblu-support-production environment ` +
        `group before webhook fields can be read or changed`,
    );
  }

  return { appId, token: `${appId}|${appSecret}` };
}

/**
 * The app-level half: `/{app-id}/subscriptions`, authenticated with the app
 * token. The path is built here rather than by each caller — composing it at the
 * call site meant an unset `META_APP_ID` produced the path
 * `undefined/subscriptions` and a baffling Graph error, instead of the message
 * above naming the variable to set.
 */
async function graph<T>(init: {
  method: 'GET' | 'POST';
  query?: Record<string, string>;
}): Promise<T> {
  // Resolved before the try: a missing credential is a configuration error, and
  // throwing it inside would have it caught below and reported as the network
  // being unreachable.
  const { appId, token } = appCredentials();

  // The token goes in the header, not in the query string as the other two
  // Graph clients do. An app access token contains the app secret verbatim,
  // and a URL is the part of a request that ends up in logs and error
  // messages.
  return request<T>('Graph API', `${GRAPH_BASE}/${appId}/subscriptions`, token, init);
}

/** What the app is subscribed to today, or null if it has no subscription. */
export async function readSubscription(object: string): Promise<GraphSubscription | null> {
  const body = await graph<{ data?: GraphSubscription[] }>({ method: 'GET' });

  return body.data?.find((entry) => entry.object === object) ?? null;
}

export type SubscriptionPlan = {
  object: string;
  callbackUrl: string;
  /** Field names already subscribed, as Graph reported them. */
  current: string[];
  /** What will be written: every current field plus whatever was missing. */
  merged: string[];
  /** The subset of `want` that is not subscribed yet. Empty means no-op. */
  adding: string[];
};

/**
 * Work out the field list to write, and refuse to produce one that loses a field.
 *
 * This exists as a pure function because of what the write does. Graph's
 * `POST /{app-id}/subscriptions` does not add fields — it *replaces* the list
 * with whatever `fields` holds, so a request naming only `account_alerts`
 * silently unsubscribes `messages` and every inbound WhatsApp message and
 * delivery status stops arriving. Meta reports that as success.
 *
 * So the merge is the safety-critical part of this job rather than an
 * implementation detail, and it is tested directly.
 */
/**
 * Merge `want` into `current` without ever losing a field.
 *
 * Shared by both levels because both writes replace the list rather than adding
 * to it, and because a merge that is right in one place and wrong in the other
 * is the same outage with a different cause. Meta does not document the
 * page-level write as replacing — but writing the merged list is correct under
 * either reading, and assuming "adds" is the assumption that costs a channel.
 */
function mergeFields(
  current: string[],
  want: readonly string[],
): { current: string[]; merged: string[]; adding: string[] } {
  const adding = want.filter((field) => !current.includes(field));
  const merged = [...current, ...adding];

  // Belt and braces: the caller writes `merged`, so anything that ever dropped a
  // subscribed field must fail here rather than reach Graph.
  const lost = current.filter((field) => !merged.includes(field));
  if (lost.length > 0) {
    throw new GraphSubscriptionError(
      `Refusing to write a field list that drops ${lost.join(', ')} — this is a bug`,
    );
  }

  return { current, merged, adding };
}

export function planFieldSubscription(
  existing: GraphSubscription,
  want: readonly string[],
): SubscriptionPlan {
  const { current, merged, adding } = mergeFields(
    existing.fields.map((field) => field.name),
    want,
  );

  if (!existing.callback_url) {
    throw new GraphSubscriptionError(
      `The ${existing.object} subscription has no callback URL to preserve. ` +
        `Fix the subscription in the App Dashboard first; this job adds fields ` +
        `to a working subscription rather than creating one.`,
    );
  }

  return { object: existing.object, callbackUrl: existing.callback_url, current, merged, adding };
}

/**
 * Write the merged field list.
 *
 * `callback_url` is echoed back from the read rather than rebuilt from
 * `APP_URL`: a webhook override can point a WABA somewhere other than the app's
 * default, and reconstructing the URL would quietly retarget the subscription
 * while appearing to only add a field.
 */
export async function applyFieldSubscription(plan: SubscriptionPlan): Promise<void> {
  const verifyToken = metaVerifyToken();
  if (!verifyToken) {
    throw new GraphSubscriptionError(
      'META_VERIFY_TOKEN is not set. Graph re-runs the subscription handshake ' +
        'against the callback URL on every write, and it fails without it.',
    );
  }

  await graph({
    method: 'POST',
    query: {
      object: plan.object,
      callback_url: plan.callbackUrl,
      fields: plan.merged.join(','),
      verify_token: verifyToken,
      // Without this Graph subscribes to the *names* of the changed fields and
      // sends no `value` object. Every parser in this system reads
      // `change.value`, so an omitted flag would deliver empty webhooks.
      include_values: 'true',
    },
  });
}

// --- The page-level half: /{page-id}/subscribed_apps ------------------------

/**
 * What one app's installation on a Page looks like.
 *
 * `subscribed_fields` is absent rather than empty on an app installed with no
 * fields, so it is optional here and normalised at the read.
 */
export type PageSubscribedApp = {
  id: string;
  name?: string;
  subscribed_fields?: string[];
};

export type PageSubscriptionPlan = {
  pageId: string;
  /** False when this app is not installed on the Page at all yet. */
  installed: boolean;
  current: string[];
  merged: string[];
  adding: string[];
};

/**
 * A Page-token call against `/{page-id}/subscribed_apps`.
 *
 * Separate from `graph` above, though both send through `request()`: what
 * differs is everything `request()` is handed — a different node, a different
 * token, and a failure that means something else.
 * The app token cannot install an app on a Page — that is a decision only
 * somebody with `CREATE_CONTENT`, `MANAGE` or `MODERATE` on the Page can make,
 * so Meta requires a token minted for such a person.
 *
 * The token goes in the header for the same reason the app token does: a URL is
 * the part of a request that ends up in logs and error messages.
 */
async function pageGraph<T>(
  pageId: string,
  init: { method: 'GET' | 'POST'; query?: Record<string, string> },
): Promise<T> {
  const token = env().META_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new GraphSubscriptionError(
      'META_PAGE_ACCESS_TOKEN is not set. Installing this app on a Page needs a ' +
        'Page access token; the app token that writes the app-level subscription ' +
        'cannot do it.',
    );
  }

  return request<T>(
    'Graph API',
    `${GRAPH_BASE}/${pageId}/subscribed_apps`,
    token,
    init,
    // The two permissions are named because this call is the one that fails
    // for want of them, and Graph's own sentence names neither. Both are
    // dependencies nobody requests deliberately — see
    // `plans/meta-app-review-submission.md`.
    `This call needs a Page token whose person can MANAGE the Page, ` +
      `and the pages_manage_metadata and pages_show_list permissions. A token ` +
      `missing either is refused with a message that names neither.`,
  );
}

/**
 * The fields this app is subscribed to *on the Page*, or null if it is not
 * installed there.
 *
 * Null and `[]` are different answers and the caller says different things
 * about them: an app that is not installed has never received a Page event at
 * all, and an app installed with no fields is subscribed to nothing. Both are
 * fixed by the same write, but only the first explains a channel that has never
 * worked.
 */
export async function readPageSubscription(pageId: string): Promise<string[] | null> {
  const appId = env().META_APP_ID;
  if (!appId) {
    throw new GraphSubscriptionError(
      'META_APP_ID must be set to tell which of the apps installed on the Page is ours',
    );
  }

  const body = await pageGraph<{ data?: PageSubscribedApp[] }>(pageId, { method: 'GET' });

  // Matched on the app id rather than taking the first entry: a Page can have
  // several apps installed, and writing another one's field list would be both
  // wrong and invisible.
  const ours = body.data?.find((app) => app.id === appId);
  if (!ours) return null;

  return ours.subscribed_fields ?? [];
}

export function planPageSubscription(
  pageId: string,
  current: string[] | null,
  want: readonly string[],
): PageSubscriptionPlan {
  const merged = mergeFields(current ?? [], want);

  return { pageId, installed: current !== null, ...merged };
}

/**
 * Install the app on the Page with the merged field list.
 *
 * The same call both installs and updates — there is no separate install step —
 * which is why a Page that has never had the app on it needs no different
 * handling here.
 */
export async function applyPageSubscription(plan: PageSubscriptionPlan): Promise<void> {
  await pageGraph(plan.pageId, {
    method: 'POST',
    query: { subscribed_fields: plan.merged.join(',') },
  });
}

// --- The direct Instagram half: graph.instagram.com/{ig-id}/subscribed_apps ---

/**
 * The account-level subscription for the **Instagram Login** connection.
 *
 * A third subscription, and it belongs to neither of the two above. The app
 * level (`/{app-id}/subscriptions`) is shared — one app, one `instagram` object
 * subscription, serving both connections — but each connection then has its own
 * account-level half, and they are addressed to different nodes on different
 * hosts with different credentials:
 *
 *   Page connection      POST graph.facebook.com/{page-id}/subscribed_apps    Page token
 *   Direct connection    POST graph.instagram.com/{ig-id}/subscribed_apps     Instagram token
 *
 * This is the call `subscribePage`'s comment once explained *not* to make, and
 * the analysis there was right — it was the deployment that changed. Meta's
 * Instagram webhook doc shows
 * `POST /me/subscribed_apps?subscribed_fields=comments,messages` addressed to
 * `graph.instagram.com`, which is this product and not the Page's, so writing
 * `comments` into a Page's field list would have been an invalid field name in
 * the wrong vocabulary. Now that the account is also connected through Instagram
 * Login, that curl is exactly the right call — made to the host the doc actually
 * names.
 *
 * Which is the whole lesson from §6.26 and §6.35 in one place: **the two
 * connections differ in the host, the token, the ids and the field vocabulary,
 * so an example proves nothing until you check which host its URL names.**
 */
function instagramToken(): string {
  const token = env().INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    throw new GraphSubscriptionError(
      'INSTAGRAM_ACCESS_TOKEN is not set, so the direct Instagram connection has no ' +
        'credential to subscribe with. It is the Instagram user access token from ' +
        'Instagram → API setup with Instagram login; the Page token cannot stand in for it.',
    );
  }
  return token;
}

async function instagramGraph<T>(
  accountId: string,
  init: { method: 'GET' | 'POST'; query?: Record<string, string> },
): Promise<T> {
  const token = instagramToken();

  // Header rather than query string, as everywhere else here: a URL is the
  // part of a request that ends up in logs and error messages.
  return request<T>(
    'graph.instagram.com',
    `${INSTAGRAM_GRAPH_BASE}/${accountId}/subscribed_apps`,
    token,
    init,
    `This call is addressed to graph.instagram.com and authenticated with ` +
      `INSTAGRAM_ACCESS_TOKEN. A Page token sent here is refused with a message that names ` +
      `neither, and so is an Instagram token sent to graph.facebook.com — check which of ` +
      `the two credentials is in the variable before reading anything else into this.`,
  );
}

/**
 * The fields the direct connection is subscribed to, or null when the account
 * has no subscription at all.
 *
 * Meta documents the POST for this endpoint and not the GET, so the response is
 * read defensively: any of `data[]`, its `subscribed_fields`, and the entries'
 * own ids may be absent, and every one of those is a *different* shape from
 * "subscribed to nothing". The distinction that matters is null versus `[]`,
 * exactly as on the Page: null means no subscription has ever been made, which
 * is what explains an account that has never delivered an event.
 *
 * It is read rather than skipped because the POST **replaces** the field list.
 * That is documented for the app level and assumed here, on the same reasoning
 * `mergeFields` already carries: writing the merged list is correct under either
 * reading, and assuming "adds" is the assumption that costs a channel.
 */
export async function readInstagramLoginSubscription(accountId: string): Promise<string[] | null> {
  const body = await instagramGraph<{ data?: { subscribed_fields?: string[] }[] }>(accountId, {
    method: 'GET',
  });

  const entries = body?.data;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // Unioned across entries rather than taking the first. The token is scoped to
  // one app so there should only ever be one, and an unexpected second entry
  // must widen what we preserve rather than be silently dropped.
  const fields = new Set<string>();
  for (const entry of entries) {
    for (const field of entry?.subscribed_fields ?? []) fields.add(field);
  }

  return [...fields];
}

export type InstagramLoginSubscriptionPlan = {
  accountId: string;
  /** False when the account carries no subscription for this app yet. */
  subscribed: boolean;
  current: string[];
  merged: string[];
  adding: string[];
};

export function planInstagramLoginSubscription(
  accountId: string,
  current: string[] | null,
  want: readonly string[],
): InstagramLoginSubscriptionPlan {
  // The same merge as both other levels, deliberately: all three writes replace
  // rather than add, and a merge that is right in one place and wrong in another
  // is the same outage with a different cause.
  const merged = mergeFields(current ?? [], want);

  return { accountId, subscribed: current !== null, ...merged };
}

export async function applyInstagramLoginSubscription(
  plan: InstagramLoginSubscriptionPlan,
): Promise<void> {
  await instagramGraph(plan.accountId, {
    method: 'POST',
    query: { subscribed_fields: plan.merged.join(',') },
  });
}
