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

  APP_URL: z.url(),

  /** Guards the cron/job endpoints and signs CSRF tokens. */
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),

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

  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_WABA_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  /** Used to verify X-Hub-Signature-256 on inbound Meta webhooks. */
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

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
