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
   * Comma-separated origins permitted to embed the chat widget, e.g.
   * "https://support.shipblu.com,https://app.shipblu.com". Our own origin is
   * always allowed. Everything outside this list is refused by
   * `frame-ancestors`.
   */
  WIDGET_ALLOWED_ORIGINS: z.string().optional(),

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
  SHIPMENT_TRACKING_PATTERN: z.string().optional(),
  SHIPMENT_SBID_PATTERN: z.string().optional(),
  /**
   * Comma-separated tracking numbers never to link. One specific hazard: a
   * canned response or signature carrying a worked example would otherwise
   * attach the same shipment to every ticket that used it.
   */
  SHIPMENT_IGNORE: z.string().optional(),

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
   * Meta: WhatsApp, Messenger and Instagram.
   *
   * One credential each, shared by all three products, because one Meta app
   * serves all three.
   *
   * There used to be a WHATSAPP_* set alongside these, with the Meta keys
   * falling back to them — the idea being that a second app could serve
   * WhatsApp separately. Nobody did that, and the duplication cost more than
   * the flexibility was worth: the same token had to be pasted twice, which
   * meant a rotation done once left the other copy stale, and the fallback made
   * it ambiguous which of the two a given call had actually used.
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
   * equivalent to collapse into.
   */
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_APP_ID: z.string().optional(),
  FACEBOOK_PAGE_ID: z.string().optional(),
  INSTAGRAM_ACCOUNT_ID: z.string().optional(),

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
  return env().META_APP_SECRET ?? warnIfOnlyLegacy('META_APP_SECRET', 'WHATSAPP_APP_SECRET');
}

/** The token Meta echoes back during the subscription handshake. */
export function metaVerifyToken(): string | undefined {
  return env().META_VERIFY_TOKEN ?? warnIfOnlyLegacy('META_VERIFY_TOKEN', 'WHATSAPP_VERIFY_TOKEN');
}

/** Warned about at most once per key, so a busy webhook does not flood the log. */
const warnedLegacyKeys = new Set<string>();

/**
 * Names the missed migration step when the retired WHATSAPP_* key is still set
 * and its Meta replacement is not.
 *
 * Worth the few lines because of how this fails otherwise. A missing app secret
 * does not error — it makes `verifySignature` return false, and the webhook
 * route then stores the payload as unverified and answers 403. Every inbound
 * WhatsApp message is dropped, the log says "stored an unverified payload", and
 * that reads as a forgery or a wrong secret rather than as a value that needs
 * copying from one environment variable to another. Meta eventually disables a
 * subscription that keeps failing, so the quiet version of this is expensive.
 *
 * Deliberately does not *use* the legacy value: the point of collapsing the two
 * sets is that there is one place to look, and silently reading the old key
 * would leave a half-migrated environment working until the day someone
 * rotated the credential and only updated the new one.
 */
function warnIfOnlyLegacy(current: string, legacy: string): undefined {
  if (!process.env[legacy] || warnedLegacyKeys.has(legacy)) return undefined;

  warnedLegacyKeys.add(legacy);
  console.error(
    `${current} is not set, but the retired ${legacy} still is. WhatsApp, ` +
      `Messenger and Instagram now share one credential set: copy the value ` +
      `into ${current} in the shipblu-shared environment group and remove ` +
      `${legacy}. Until then every inbound Meta webhook fails verification.`,
  );

  return undefined;
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

/**
 * Only for tests, which mutate process.env between cases.
 *
 * Clears the warn-once record too: it is knowledge about the environment just
 * as much as the parsed values are, and a case that expects the legacy warning
 * would otherwise pass or fail on whether an earlier case had already tripped
 * it.
 */
export function resetEnvCache(): void {
  cached = null;
  warnedLegacyKeys.clear();
}
