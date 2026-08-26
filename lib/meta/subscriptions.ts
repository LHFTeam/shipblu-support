import { env, metaAppSecret, metaVerifyToken } from '@/lib/env';

/**
 * The app's own webhook field subscriptions.
 *
 * Separate from `lib/meta/client` and `lib/whatsapp/client` even though all
 * three talk to graph.facebook.com, because this one is addressed and
 * authenticated differently from both: the endpoint is `/{app-id}/subscriptions`
 * rather than a page or phone number, and it takes an *app* access token, which
 * the page token cannot stand in for.
 *
 * This is configuration, not traffic. It runs from `npm run job --
 * subscribe_meta_webhooks` and nowhere else, which is why nothing here retries:
 * a person is watching the output, and a failure they can read beats a retry
 * that hides which half of a two-step change actually landed.
 */

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** The Webhooks objects this app subscribes to, one per product. */
export const WHATSAPP_OBJECT = 'whatsapp_business_account';
export const INSTAGRAM_OBJECT = 'instagram';
export const PAGE_OBJECT = 'page';

/**
 * What the WhatsApp pipeline needs delivered.
 *
 * `messages` carries inbound customer messages *and* delivery statuses, so it is
 * the field the whole channel rests on — it is listed here because this job
 * rewrites the field list wholesale and the merge must be able to prove it is
 * still present, not because anything expects it to be missing.
 *
 * `message_echoes` is the bot's half of the transcript: the read-only
 * `whatsapp_bot` channel is a number another service sends on, and without
 * echoes we archive what customers said and nothing said back to them.
 *
 * `smb_message_echoes` is deliberately absent. It looks like the same thing and
 * is not — it covers a business replying from the WhatsApp Business app or a
 * linked companion device, which is not how this number is operated.
 */
export const REQUIRED_WHATSAPP_FIELDS = ['messages', 'message_echoes'] as const;

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
 */
export const REQUIRED_INSTAGRAM_FIELDS = ['messages', 'comments'] as const;

/**
 * What the Facebook Page pipeline needs delivered.
 *
 * `feed` rather than a comments field, because Facebook has none: the same field
 * carries comments, likes, shares and post edits, discriminated by `value.item`.
 * `lib/meta/parse.ts` keeps the comments and drops the rest, which is the cost
 * of the only field Meta offers.
 */
export const REQUIRED_PAGE_FIELDS = ['messages', 'feed'] as const;

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
 * Every call this module makes is against `/{app-id}/subscriptions`, so the path
 * is built here rather than by each caller. That is not tidiness: composing it
 * at the call site meant an unset `META_APP_ID` produced the path
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

  const url = new URL(`${GRAPH_BASE}/${appId}/subscriptions`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    // The token goes in the header, not in the query string as the other two
    // Graph clients do. An app access token contains the app secret verbatim,
    // and a URL is the part of a request that ends up in logs and error
    // messages.
    response = await fetch(url, {
      method: init.method,
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new GraphSubscriptionError(
      `Graph API unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  if (!response.ok) {
    const error = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
    throw new GraphSubscriptionError(
      typeof error.message === 'string' ? error.message : `HTTP ${response.status}`,
      response.status,
      typeof error.code === 'number' ? error.code : null,
      typeof error.fbtrace_id === 'string' ? error.fbtrace_id : null,
    );
  }

  return body as T;
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
 * with whatever `fields` holds, so a request naming only `message_echoes`
 * silently unsubscribes `messages` and every inbound WhatsApp message and
 * delivery status stops arriving. Meta reports that as success.
 *
 * So the merge is the safety-critical part of this job rather than an
 * implementation detail, and it is tested directly.
 */
export function planFieldSubscription(
  existing: GraphSubscription,
  want: readonly string[],
): SubscriptionPlan {
  const current = existing.fields.map((field) => field.name);
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
