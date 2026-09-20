import { z } from 'zod';

/**
 * Environment validation shared by the web app, the worker and the job runner.
 *
 * Parsing is lazy so that `next build` (which runs without runtime secrets) does
 * not fail, while anything that actually touches the database or a provider gets
 * a clear error at first use instead of a confusing `undefined` downstream.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Supavisor transaction pooler. Used for all normal app queries. */
  DATABASE_URL: z.string().min(1),
  /**
   * Direct/session-mode connection. Required for LISTEN, which the transaction
   * pooler does not support. Falls back to DATABASE_URL for local development
   * where both point at the same plain Postgres.
   */
  DATABASE_URL_SESSION: z.string().min(1).optional(),

  /**
   * Absolute base URL for links we put in front of a person — an invite, a
   * survey. Optional here and required by `appUrl()` at the point of use.
   *
   * It was required, and that made it a prerequisite for opening a database
   * connection, because `db/client.ts` validates the whole schema before
   * connecting. The cron services have no URL of their own and were never given
   * one, so every job that touched the database died at validation with a
   * message about a variable it had no use for. A background job that never
   * builds a link should not need to know the site's address.
   */
  APP_URL: z.url().optional(),

  /** Guards the cron/job endpoints and signs CSRF tokens. */
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),

  /**
   * Hostname the public help centre is served on, e.g. support.shipblu.com.
   * The proxy rewrites requests arriving here under /kb, and canonical and
   * sitemap URLs are built from it. Unset means the help centre is only
   * reachable at /kb on the console's own hostname.
   */
  KB_PUBLIC_HOST: z.string().optional(),

  /**
   * A service notice, shown across the top of every public help centre page.
   *
   * Configuration rather than content, and an environment variable rather than a
   * table, because there is nowhere yet for an admin to type one: the banner is
   * built and its backing store is not. This is the cheapest seam that is still
   * real — an ops person can put a delay notice in front of every customer from
   * the Render dashboard without a deploy or a code change, and the day a
   * proper `service_notices` table lands, `lib/kb/notice.ts` is the one file
   * that changes.
   *
   * Unset means no banner, which is the only safe default: an operational claim
   * about ShipBlu's network must be one somebody actually made.
   *
   * Both locales, because the reader's own language is the one that should
   * reach them and the majority of them read Arabic — see `lib/kb/notice.ts`
   * for what happens when only one is set.
   */
  KB_NOTICE_EN: z.string().optional(),
  KB_NOTICE_AR: z.string().optional(),
  /**
   * Where "read the update" points. Optional; the banner is text without it.
   * Validated at the point of use rather than here, so a bad value drops the
   * link instead of taking down every page that renders the banner.
   */
  KB_NOTICE_HREF: z.string().optional(),
  /** How loud the banner is. Defaults to `warning`, which is what a delay is. */
  KB_NOTICE_TONE: z.enum(['info', 'warning', 'danger']).default('warning'),

  /**
   * Comma-separated origins permitted to embed the chat widget, e.g.
   * "https://support.shipblu.com,https://app.shipblu.com". Our own origin is
   * always allowed. Everything outside this list is refused by
   * `frame-ancestors`.
   */
  WIDGET_ALLOWED_ORIGINS: z.string().optional(),

  /**
   * Shared secret the host page's *backend* signs a widget identity with, so a
   * merchant dashboard can say who its visitor is and be believed.
   *
   * Optional, and its absence is a working state rather than a broken one: an
   * unsigned identity is still accepted and still fills in the name and address
   * an agent reads, it just never links the person to a shipping account. See
   * `lib/widget/identity.ts` for what the signature covers and why that half.
   *
   * Per environment, never shared with staging: a secret that signs identities
   * on two deployments lets a claim minted against one be replayed at the other.
   */
  WIDGET_IDENTITY_SECRET: z.string().optional(),

  /**
   * Overrides for how a tracking number and an SBID are recognised in message
   * text. Both are regular-expression sources; `lib/shipments/detect.ts` holds
   * the defaults and falls back to them, loudly, if one does not compile.
   *
   * These exist because the real ShipBlu formats were not settled when the
   * feature landed, and changing a pattern should not need a deploy. The
   * defaults are still the source of truth — set these only to correct them.
   *
   * Declared here so this file stays the catalogue of everything the system
   * reads, but read straight from `process.env` by `detect.ts`: that module is
   * reachable from the inbox search parser, and validating this whole schema on
   * that path would fail a search on a variable a search has no use for.
   */
  /**
   * Controls for the ticket categoriser, all three read straight from
   * `process.env` by `lib/categorise/` for the same reason the shipment
   * patterns are: that module is reachable from the ingest path and from a page
   * render, and validating this whole schema there would let one unrelated
   * missing variable stop tickets being categorised.
   *
   * `CATEGORISE_DISABLED_RULES` is a comma-separated list of rule keys, and it
   * is the one that matters in an incident: a rule found to be filing half the
   * queue under one label is switched off in the time it takes to restart a
   * service, rather than the time it takes to ship a deploy. There is
   * deliberately no matching way to *add* a rule — turning one off is safe and
   * reversible, and adding one would be a regular expression in an env var with
   * no test and no review.
   *
   * The two thresholds are numbers in 0..1 and exist so the auto-apply and
   * review bands can be recalibrated against measured precision without a
   * deploy. A value that will not parse is logged and ignored in favour of the
   * constant, because a mistyped threshold must not stop categorisation.
   */
  CATEGORISE_DISABLED_RULES: z.string().optional(),
  CATEGORISE_AUTO_MIN: z.string().optional(),
  CATEGORISE_RECORD_MIN: z.string().optional(),

  SHIPMENT_TRACKING_PATTERN: z.string().optional(),
  SHIPMENT_SBID_PATTERN: z.string().optional(),
  /**
   * Comma-separated tracking numbers never to link. One specific hazard: a
   * canned response or signature carrying a worked example would otherwise
   * attach the same shipment to every ticket that used it.
   */
  SHIPMENT_IGNORE: z.string().optional(),

  /**
   * Base URL of the ShipBlu delivery platform, without a trailing slash.
   *
   * Optional, and read through `env()` rather than `process.env` — unlike the
   * three pattern variables above, nothing on the search-parser path imports the
   * platform client, so there is no context where validating the schema here
   * could fail a request that only wanted to parse a query.
   *
   * It exists at all so staging can be pointed at a sandbox, and so a bad
   * production host is one dashboard edit rather than a deploy. Absent means the
   * real platform: `lib/shipments/platform.ts` falls back to
   * `DEFAULT_SHIPBLU_API_URL`.
   */
  SHIPBLU_API_URL: z.url().optional(),

  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('attachments'),

  /** Which driver lib/email/providers resolves. `local` writes to .mail-outbox/. */
  EMAIL_PROVIDER: z.enum(['local', 'postmark', 'mailgun']).default('local'),
  /** Postmark server token. */
  EMAIL_API_KEY: z.string().optional(),
  /**
   * Password half of the Basic Auth credential on the inbound webhook URL.
   * Postmark does not sign inbound payloads, so this is the whole of the
   * authentication — an unset value leaves the endpoint open, which the driver
   * warns about loudly rather than failing closed on.
   */
  EMAIL_WEBHOOK_SECRET: z.string().optional(),
  /** Envelope sender, e.g. support@shipblu.com */
  EMAIL_FROM_ADDRESS: z.email().optional(),
  EMAIL_FROM_NAME: z.string().default('ShipBlu Support'),
  /**
   * Domain used to build plus-addressed reply tokens
   * (support+<token>@shipblu.com). Defaults to the EMAIL_FROM_ADDRESS domain.
   */
  EMAIL_REPLY_DOMAIN: z.string().optional(),
  /**
   * `true` if mail addressed to `<mailbox>+<token>@<reply domain>` actually
   * reaches the inbound webhook. Off unless a deployment has proved it does.
   *
   * The reply token is the most reliable of the three threading signals, but it
   * is the only one that needs the *mail path* to cooperate, and this one does
   * not: `shipblu.com` is hosted at Zoho, which forwards the single address
   * `help-support@shipblu.com` on to Postmark's inbound endpoint. A plus-suffixed
   * variant is not that address, so it is rejected before Postmark ever sees it
   * and the sender gets a bounce — see `docs/PROJECT-STATE.md` §6.41.
   *
   * Inbound still *accepts* the token wherever one appears, so turning this on
   * later needs no migration and tokens already in the wild keep threading.
   */
  EMAIL_REPLY_PLUS_ADDRESSING: z.string().optional(),

  /**
   * Meta: WhatsApp, Messenger and Instagram.
   *
   * One credential each, shared by all three products, because one Meta app
   * serves all three.
   *
   * There used to be a WhatsApp-specific set alongside these, with the Meta
   * keys falling back to it — the idea being that a second app could serve
   * WhatsApp separately. Nobody did that, and the duplication cost more than
   * the flexibility was worth: the same token had to be pasted twice, which
   * meant a rotation done once left the other copy stale, and the fallback made
   * it ambiguous which of the two a given call had actually used.
   *
   * Those names are gone, and nothing looks for them any more — not even to
   * warn. That is the trade-off to know about before touching this: an
   * environment still holding only the retired name reads as unconfigured, so
   * `verifySignature` returns false, every inbound webhook is stored unverified
   * and answered 403, and the log says "stored an unverified payload" — which
   * reads as a forgery rather than as a value that needs copying. Meta
   * eventually disables a subscription that keeps failing. Confirm
   * `META_APP_SECRET` and `META_VERIFY_TOKEN` are set before cutting an
   * environment over.
   *
   * `META_PAGE_ACCESS_TOKEN` sends on every channel and lists WhatsApp
   * templates. `META_APP_SECRET` verifies X-Hub-Signature-256 on every inbound
   * webhook, and `META_VERIFY_TOKEN` answers Meta's subscription handshake for
   * all of them.
   *
   * `META_APP_ID` is the odd one out: an app id is public, not a secret. It is
   * here because the webhook *subscription* endpoint is addressed by app id and
   * authenticated with an app access token, which is the app id and the app
   * secret joined by a pipe. Nothing else in the system needs it, which is why
   * it went missing until `subscribe_meta_webhooks` had to have it.
   *
   * The remaining WHATSAPP_* keys below are ids, not credentials — they name
   * which phone number and business account to use, and have no Meta-app
   * equivalent to collapse into. Since more than one WABA can be connected they
   * are the *fallback*, not the configuration: `whatsapp_accounts` rows are, and
   * the template sync turns these into the first such row on its next run. They
   * stay because they are what a fresh install has before anyone opens the
   * admin screen, and what every send falls back to when nothing is connected.
   *
   * A second account that needs its own credential names a `WHATSAPP_TOKEN_*`
   * variable on its row, which is read directly from `process.env` — the name
   * is data, so it cannot be declared here. `lib/whatsapp/accounts.ts` holds the
   * rule that constrains which names are allowed.
   */
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_APP_ID: z.string().optional(),
  FACEBOOK_PAGE_ID: z.string().optional(),
  INSTAGRAM_ACCOUNT_ID: z.string().optional(),

  /**
   * The direct Instagram connection, and the one place the "one app, one
   * credential" rule above does not hold.
   *
   * An Instagram professional account can be connected two ways, and this app
   * is connected **both** ways at once. Through the **Facebook Page** it is
   * linked to, which is what everything above assumes: the Page token sends, the
   * app secret signs, and `graph.facebook.com` serves. And through **Instagram
   * Login**, which is its own setup inside the same Meta app, with its own
   * access token, its own app secret, and `graph.instagram.com` as the host. The
   * App Review permissions are named for the flow — `instagram_manage_comments`
   * for the first, `instagram_business_manage_comments` for the second.
   *
   * The two are not alternatives here. Meta delivers the same event on both, so
   * a webhook must verify against either secret, and an outbound call has to
   * pick a route — see `lib/meta/connection.ts`, which is where that decision
   * lives and why.
   *
   * Both keys stay optional, and unset is the Page-only deployment every
   * environment had before the second connection existed: `metaConnection()`
   * keys on `INSTAGRAM_ACCESS_TOKEN` being present rather than on a mode flag,
   * so an environment holding neither behaves exactly as it did. Set them
   * together. Setting the token without the secret is the worst of the three
   * states — sends route to `graph.instagram.com` while every delivery that
   * connection signs is answered 403 and dropped, which is §6.26 and §6.29 in
   * `docs/PROJECT-STATE.md`, 3,888 lost deliveries between them.
   */
  INSTAGRAM_APP_SECRET: z.string().optional(),
  META_INSTAGRAM_APP_SECRET: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_WABA_ID: z.string().optional(),

  /**
   * Freshdesk, for the knowledge base importer only. Unset means the import
   * job skips rather than fails, so the cron that runs it is green before the
   * migration is scheduled.
   */
  FRESHDESK_DOMAIN: z.string().optional(),
  FRESHDESK_API_KEY: z.string().optional(),

  /** Worker tuning. */
  /**
   * `true` prints every inbound webhook delivery — headers and raw body — before
   * it is verified or parsed. For a debugging session, not for steady state: it
   * puts customer message content into the Render log, and the log is a less
   * protected place than the database. Credentials are stripped regardless.
   *
   * Read through `process.env` in `lib/webhooks/log.ts` rather than through
   * `env()`, for the reason `SHIPMENT_TRACKING_PATTERN` above is: a diagnostic
   * must not be able to fail the request it was only meant to describe. Declared
   * here anyway so it is discoverable and paired with `render.yaml`.
   *
   * **`z.string()` and not `z.enum(['true','false'])`, which is what it was.**
   * A strict enum here does not validate a debug flag, it arms one: this schema
   * is parsed as a whole by `env()`, which the database client, the auth helpers
   * and every page and action reach, so a value of `True` or `1` or `"true "`
   * would not have quietly disabled logging — it would have thrown for the
   * entire application, on every request, with a message about a variable that
   * has nothing to do with the page that failed. A tightened type on a
   * *diagnostic* is worth nothing and risks everything; the reader in
   * `lib/webhooks/log.ts` already treats anything but exactly `true` as off,
   * which is where that strictness belongs.
   */
  LOG_ALL_INCOMING_WEBHOOKS: z.string().optional(),

  /**
   * How long any one query may wait for a pool slot plus execution, before
   * `db/client.ts` cancels it.
   *
   * There is no library setting for this — postgres.js queues past `max` with no
   * deadline and a promise that never rejects — so the number is ours to choose,
   * and it is chosen against two facts rather than as a round figure. The
   * slowest statement this system issues on purpose is the nightly rollup at
   * roughly three seconds, so thirty leaves an order of magnitude of headroom
   * for a maintenance query nobody wants to see fail. And a page that has been
   * waiting thirty seconds has already lost its reader, so the only thing a
   * longer ceiling buys is the 40-minute queue of §62.
   *
   * Declared in `shipblu-shared` and left at its default: it is a property of
   * the driver rather than of an environment, and both halves of the system are
   * better off agreeing on it than differing by accident. A service that
   * genuinely needs longer — a backfill may, a request never does — sets it at
   * the service level, which Render gives precedence over the group, and that is
   * the deliberate per-service exception AGENTS.md describes rather than the
   * normal way to configure this.
   */
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Session-mode URL for LISTEN, falling back to the pooled URL in local dev. */
export function sessionDatabaseUrl(): string {
  const e = env();
  return e.DATABASE_URL_SESSION ?? e.DATABASE_URL;
}

/**
 * The site's own base URL, for building an absolute link.
 *
 * Throws where it is genuinely needed rather than at startup everywhere, so the
 * error names the thing that could not be built instead of appearing in a job
 * that only wanted a database connection.
 */
export function appUrl(): string {
  const value = env().APP_URL;
  if (!value) {
    throw new Error('APP_URL must be set to build an absolute link back to this site');
  }
  return value.replace(/\/$/, '');
}

/**
 * The app secret every inbound Meta webhook is signed with — WhatsApp,
 * Messenger and Instagram alike.
 */
export function metaAppSecret(): string | undefined {
  return env().META_APP_SECRET;
}

/**
 * The Instagram app secret, under both names it can be set with.
 *
 * `INSTAGRAM_APP_SECRET` is what Meta's dashboard calls it and what this repo
 * asks for; `META_INSTAGRAM_APP_SECRET` is the name shipped first and still
 * honoured. Returned as a pair rather than coalesced because the *names* are
 * what `lib/meta/signing.ts` writes into `webhook_events.error` — "signature did
 * not match INSTAGRAM_APP_SECRET or META_APP_SECRET" is a sentence that names
 * which variables were read, and it is how both Instagram outages were finally
 * diagnosed. Coalescing here would report a name that may hold nothing.
 *
 * Both undefined means the direct Instagram connection is not configured, which
 * is a supported state and not a misconfiguration: an account reached only
 * through its Facebook Page is signed with `META_APP_SECRET` like everything
 * else.
 */
export function instagramAppSecrets(): { current?: string; legacy?: string } {
  const e = env();
  return { current: e.INSTAGRAM_APP_SECRET, legacy: e.META_INSTAGRAM_APP_SECRET };
}

/** The token Meta echoes back during the subscription handshake. */
export function metaVerifyToken(): string | undefined {
  return env().META_VERIFY_TOKEN;
}

/** Domain that plus-addressed reply tokens are built against. */
export function replyDomain(): string {
  const e = env();
  if (e.EMAIL_REPLY_DOMAIN) return e.EMAIL_REPLY_DOMAIN;
  const from = e.EMAIL_FROM_ADDRESS;
  if (!from) {
    throw new Error('Set EMAIL_REPLY_DOMAIN or EMAIL_FROM_ADDRESS to derive the reply domain');
  }
  const domain = from.split('@')[1];
  if (!domain) throw new Error(`EMAIL_FROM_ADDRESS is not a valid address: ${from}`);
  return domain;
}

/** Only for tests, which mutate process.env between cases. */
export function resetEnvCache(): void {
  cached = null;
}
