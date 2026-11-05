import { env } from '@/lib/env';
import type { MetaPlatform } from './types';

/**
 * Which of the three Meta connections a piece of Instagram traffic belongs to.
 *
 * An Instagram professional account can be reached three ways, and this app
 * has been connected two of them at once since 2026-08-30 and is being moved
 * onto the third. They are not three spellings of one thing:
 *
 * | | `facebook_page` | `instagram_login` | `unified_login` |
 * | --- | --- | --- | --- |
 * | Meta's name | Instagram API with Facebook Login | Instagram API with Instagram Login | Instagram API with Unified Login |
 * | host | `graph.facebook.com` | `graph.instagram.com` | `graph.facebook.com` |
 * | credential | `META_PAGE_ACCESS_TOKEN` (a Page token) | `INSTAGRAM_ACCESS_TOKEN` (an Instagram User token, 60 days) | `INSTAGRAM_UNIFIED_LOGIN_TOKEN` (a Business Integration System User token, never expires) |
 * | signs webhooks with | `META_APP_SECRET` | `INSTAGRAM_APP_SECRET` | `META_APP_SECRET` |
 * | permissions | `instagram_basic`, `instagram_manage_*`, `pages_*` | `instagram_business_*` | `instagram_basic`, `instagram_manage_*` |
 * | handover protocol | yes — deliveries arrive in `standby` when another app owns the thread | no | no — Meta's migration guide lists it as not yet supported |
 *
 * The ids do **not** differ between the first two, and that is the fact the
 * whole design rests on: the same account id and the same IGSID appear on both
 * connections, verified against production traffic rather than taken from
 * Meta's docs (`docs/PROJECT-STATE.md` §6.29). So a contact, a ticket and a
 * 24-hour window mean the same thing on either, and a connection is purely a
 * *route* — which host, which credential, which App Review permissions. The
 * third is addressed by the same account id — `/me/assigned_instagram_accounts`
 * is expected to list it, and the callback page warns until it does — and its
 * payloads follow the Facebook Login format, so its IGSIDs are the Page's;
 * Meta does say its **message ids** differ in format from the
 * Instagram Login connection's, which is why `plans/instagram-unified-login.md`
 * has the first live hour check for a duplicated timeline before the Instagram
 * Login connection is disconnected.
 *
 * Facebook is always `facebook_page`; there is no second way to reach a Page.
 *
 * Unified Login and the Page connection sign with the **same** app secret, so
 * an `instagram` delivery verified by `META_APP_SECRET` is labelled
 * `facebook_page` whichever of the two sent it — `lib/meta/signing.ts` cannot
 * tell them apart and does not pretend to. Nothing downstream needs it to: the
 * one reader of a delivery's connection, `lib/meta/thread.ts`, asks whether a
 * `standby` should stop a send, and it reads a Unified Login delivery as the
 * Page's — which is the right answer, because the account's thread owner
 * refuses a Unified Login send exactly as it refuses the Page's
 * (`docs/PROJECT-STATE.md` §6.108).
 */
const META_CONNECTIONS = ['facebook_page', 'instagram_login', 'unified_login'] as const;

export type MetaConnection = (typeof META_CONNECTIONS)[number];

/**
 * Whether a stored value — `webhook_events.connection`, a message's
 * `meta.connection`, both jsonb or free text — is a connection. The one guard
 * for the two readers that used to each spell the list out, so a connection
 * added here reaches both or neither.
 */
export function isMetaConnection(value: unknown): value is MetaConnection {
  return (META_CONNECTIONS as readonly unknown[]).includes(value);
}

/** How to name a connection to a person reading a ticket or a log line. */
export const CONNECTION_LABEL: Record<MetaConnection, string> = {
  facebook_page: 'the Facebook Page connection',
  instagram_login: 'the direct Instagram connection',
  unified_login: 'the Unified Login connection',
};

/** The Graph host each connection is served from. */
export const CONNECTION_HOST: Record<MetaConnection, string> = {
  facebook_page: 'graph.facebook.com',
  instagram_login: 'graph.instagram.com',
  unified_login: 'graph.facebook.com',
};

/** Whether the direct Instagram connection has a credential to call Graph with. */
export function instagramLoginConfigured(): boolean {
  return Boolean(env().INSTAGRAM_ACCESS_TOKEN);
}

/**
 * Whether the Unified Login connection has a credential to call Graph with.
 *
 * The same device as `instagramLoginConfigured`: the token's presence is the
 * flag, so there is no mode variable that can disagree with the credential
 * behind it (the reasoning is on `INSTAGRAM_APP_SECRET` in `lib/env.ts`).
 */
export function unifiedLoginConfigured(): boolean {
  return Boolean(env().INSTAGRAM_UNIFIED_LOGIN_TOKEN);
}

/**
 * The connection an outbound call goes out over.
 *
 * **Decided from configuration alone, deliberately, and not from the connection
 * the customer's message arrived on** — which is recorded beside it and is the
 * more obvious choice. The connections deliver the same message, so which one
 * is recorded on a ticket is decided by which delivery reached the ingest
 * worker first: a coin toss, restarted every time Meta retries. Routing on it
 * would make "can this ticket be answered?" non-deterministic, which is the
 * single worst property this function could have.
 *
 * So for Instagram, Unified Login wins whenever it is configured, then the
 * direct connection, then the Page. Unified Login is the better route on every
 * axis that matters: its token never expires, where the direct connection's
 * Instagram User token ran out on 2026-10-29 and took every Instagram call with
 * it (`docs/PROJECT-STATE.md`, the header), and its permissions are the
 * `instagram_*` family, which App Review already granted at Advanced Access on
 * 2026-09-19 for messaging. It is **not** a route around another app's thread
 * control, as this comment once claimed: the first three Unified Login sends
 * were refused `2534037` until this app was made the account's default app
 * on 2026-11-05 (§6.108). The direct connection keeps second place for the
 * reason it had first: it is the one route seen to send past the Page's
 * handover (§6.29). Unset leaves every
 * Instagram call going out exactly as it did before this existed — Page token,
 * `graph.facebook.com`.
 *
 * The recorded connection is kept for diagnosis, and it is what `standby` is
 * interpreted against: see `lib/meta/thread.ts`.
 */
export function metaConnection(platform: MetaPlatform): MetaConnection {
  if (platform !== 'instagram') return 'facebook_page';
  if (unifiedLoginConfigured()) return 'unified_login';
  if (instagramLoginConfigured()) return 'instagram_login';
  return 'facebook_page';
}
