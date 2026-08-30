import { env } from '@/lib/env';
import type { MetaPlatform } from './types';

/**
 * Which of the two Meta connections a piece of Instagram traffic belongs to.
 *
 * An Instagram professional account can be reached two ways, and this app is
 * connected **both** ways at once. They are not two spellings of one thing:
 *
 * | | `facebook_page` | `instagram_login` |
 * | --- | --- | --- |
 * | Meta's name | Instagram API with Facebook Login | Instagram API with Instagram Login |
 * | host | `graph.facebook.com` | `graph.instagram.com` |
 * | credential | `META_PAGE_ACCESS_TOKEN` | `INSTAGRAM_ACCESS_TOKEN` |
 * | signs webhooks with | `META_APP_SECRET` | `INSTAGRAM_APP_SECRET` |
 * | permissions | `instagram_basic`, `instagram_manage_*`, `pages_*` | `instagram_business_*` |
 * | handover protocol | yes — deliveries arrive in `standby` when another app owns the thread | no |
 *
 * The ids do **not** differ, and that is the fact the whole design rests on: the
 * same account id and the same IGSID appear on both connections, verified
 * against production traffic rather than taken from Meta's docs
 * (`docs/PROJECT-STATE.md` §6.29). So a contact, a ticket and a 24-hour window
 * mean the same thing on either, and a connection is purely a *route* — which
 * host, which credential, which App Review permissions.
 *
 * Facebook is always `facebook_page`; there is no second way to reach a Page.
 */
export type MetaConnection = 'facebook_page' | 'instagram_login';

/** How to name a connection to a person reading a ticket or a log line. */
export const CONNECTION_LABEL: Record<MetaConnection, string> = {
  facebook_page: 'the Facebook Page connection',
  instagram_login: 'the direct Instagram connection',
};

/** The Graph host each connection is served from. */
export const CONNECTION_HOST: Record<MetaConnection, string> = {
  facebook_page: 'graph.facebook.com',
  instagram_login: 'graph.instagram.com',
};

/** Whether the direct Instagram connection has a credential to call Graph with. */
export function instagramLoginConfigured(): boolean {
  return Boolean(env().INSTAGRAM_ACCESS_TOKEN);
}

/**
 * The connection an outbound call goes out over.
 *
 * **Decided from configuration alone, deliberately, and not from the connection
 * the customer's message arrived on** — which is recorded beside it and is the
 * more obvious choice. Both connections deliver the same message, so which one
 * is recorded on a ticket is decided by which delivery reached the ingest
 * worker first: a coin toss, restarted every time Meta retries. Routing on it
 * would make "can this ticket be answered?" non-deterministic, which is the
 * single worst property this function could have.
 *
 * So for Instagram the direct connection wins whenever it is configured. It is
 * the better route on every axis that matters: it is not subject to another
 * app's thread control (the Page connection has been receiving `standby` and
 * nothing else since 27 August, which means read-only), and it is the one whose
 * permissions cover comments. Unset leaves every Instagram call going out
 * exactly as it did before this existed — Page token, `graph.facebook.com`.
 *
 * The recorded connection is kept for diagnosis, and it is what `standby` is
 * interpreted against: see `lib/meta/thread.ts`.
 */
export function metaConnection(platform: MetaPlatform): MetaConnection {
  if (platform === 'instagram' && instagramLoginConfigured()) return 'instagram_login';
  return 'facebook_page';
}
