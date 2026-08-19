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
   * Facebook and Instagram.
   *
   * One page access token covers both: an Instagram professional account is
   * reached through the Facebook Page it is linked to, so there is no separate
   * Instagram credential to configure.
   *
   * The app secret and verify token fall back to the WhatsApp ones because a
   * single Meta app usually serves all three products — but they are separate
   * keys so that a second app can be used without contorting the first.
   */
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().optional(),
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  FACEBOOK_PAGE_ID: z.string().optional(),
  INSTAGRAM_ACCOUNT_ID: z.string().optional(),

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_WABA_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  /** Used to verify X-Hub-Signature-256 on inbound Meta webhooks. */
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

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
 * The app secret Meta signs Facebook and Instagram webhooks with.
 *
 * Falls back to the WhatsApp secret: one Meta app commonly serves all three
 * products, and requiring the same value to be pasted twice is how one of them
 * ends up stale.
 */
export function metaAppSecret(): string | undefined {
  const e = env();
  return e.META_APP_SECRET ?? e.WHATSAPP_APP_SECRET;
}

/** Same reasoning for the subscription handshake token. */
export function metaVerifyToken(): string | undefined {
  const e = env();
  return e.META_VERIFY_TOKEN ?? e.WHATSAPP_VERIFY_TOKEN;
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
