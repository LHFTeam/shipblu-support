import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { metaAppRoleEvents } from '@/db/schema';
import { env } from '@/lib/env';
import { configuredAccountId } from './client';
import type { MetaPlatform, NormalisedAppRole } from './types';

/**
 * Which app a Page or an Instagram account routes its conversations to, as
 * Meta's `app_roles` events have said, and what that says about a thread.
 *
 * It exists for one reading. On 2026-11-05 at 10:30:24 UTC this app was made
 * the Instagram account's default app, and every Instagram message received
 * before then had arrived in `standby` — another app owned the thread when it
 * was sent. That flag is a permanent fact about the message, so without a newer
 * fact every one of those tickets refused a reply until its customer wrote
 * again: 94 of the 98 open Instagram direct message tickets on 2026-11-06. The
 * switch is that newer fact. A send went through 20 seconds after it on a thread
 * whose last message had arrived in `standby` two minutes earlier, and no
 * Instagram message has arrived in `standby` since (`docs/PROJECT-STATE.md`
 * §6.111). Its delivery is deleted with the rest of `webhook_events` after
 * thirty days, which is why `meta_app_role_events` holds it.
 */

const DEFAULT_APP = 'default_app';

/**
 * Whether becoming a platform's default app moves the threads already open.
 *
 * Instagram: yes, on the reading above. Instagram's routing is Conversation
 * Routing, where the default app is the one that answers a thread no other app
 * holds. Messenger: no, and the evidence is the same morning. The Page's own
 * event, twelve seconds before Instagram's, named this app `default_app` too,
 * and all 23 Messenger messages received in the day after it still arrived in
 * `standby`: the Page's inbox is still held through the handover protocol by
 * Freshworks, its primary receiver. So a Page's switch supersedes nothing, and
 * a Messenger thread is taken back only by `thread_control_taken`.
 */
const DEFAULT_APP_OWNS_THREADS: Record<MetaPlatform, boolean> = {
  instagram: true,
  facebook: false,
};

/** Enough to cover every switch an account has had; they are a few a year. */
const READ_LIMIT = 50;

/**
 * Stores one app's roles as an event stated them, or nothing if that event is
 * already stored — a Meta batch is retried whole, and the backfill writes the
 * same rows from the stored deliveries. Answers whether it stored a row.
 */
export async function recordAppRole(
  role: NormalisedAppRole,
  webhookEventId: string | null,
): Promise<boolean> {
  const rows = await db
    .insert(metaAppRoleEvents)
    .values({
      platform: role.platform,
      accountId: role.accountId,
      appId: role.appId,
      roles: role.roles,
      at: role.at,
      webhookEventId,
    })
    .onConflictDoNothing({
      target: [
        metaAppRoleEvents.platform,
        metaAppRoleEvents.accountId,
        metaAppRoleEvents.at,
        metaAppRoleEvents.appId,
      ],
    })
    .returning({ id: metaAppRoleEvents.id });

  return rows.length > 0;
}

export type AppRoleEvent = { appId: string; roles: string[]; at: Date };

/**
 * Since when this app has been the account's default app, without a break, in
 * the sense that moves threads — or null.
 *
 * Read newest first. The stretch ends, going back, at an event giving this app
 * no `default_app`, or one giving it to another app; the answer is the oldest
 * event of this app's inside it. The start, not the latest event of it: a
 * message received in `standby` between the switch and a later event that
 * still names this app the default says another app took that thread in the
 * meantime, and a second statement of the same role is no evidence that it
 * gave the thread back.
 *
 * Null whenever it cannot be sure the default is this app now — no app id, no
 * event, the latest naming another app — so a ticket refuses as it did before
 * the switch was stored, the safe side of every mistake here.
 */
export function defaultAppSinceFrom(
  platform: MetaPlatform,
  events: AppRoleEvent[],
  appId: string | null,
): Date | null {
  if (!DEFAULT_APP_OWNS_THREADS[platform] || !appId) return null;

  const newestFirst = [...events].sort((a, b) => b.at.getTime() - a.at.getTime());
  let since: Date | null = null;

  for (const event of newestFirst) {
    const isDefault = event.roles.includes(DEFAULT_APP);

    if (event.appId === appId) {
      if (!isDefault) break;
      since = event.at;
    } else if (isDefault) {
      break;
    }
  }

  return since;
}

/**
 * `defaultAppSinceFrom` over the stored events for the account this deployment
 * sends from — the only account whose threads the verdict judges, since a
 * message received on another is refused as `other_account` first.
 *
 * Messenger answers null without a query (`DEFAULT_APP_OWNS_THREADS`).
 */
export async function defaultAppSince(platform: MetaPlatform): Promise<Date | null> {
  if (!DEFAULT_APP_OWNS_THREADS[platform]) return null;

  const appId = env().META_APP_ID || null;
  const accountId = configuredAccountId(platform);
  if (!appId || !accountId) return null;

  const events = await db
    .select({
      appId: metaAppRoleEvents.appId,
      roles: metaAppRoleEvents.roles,
      at: metaAppRoleEvents.at,
    })
    .from(metaAppRoleEvents)
    .where(
      and(eq(metaAppRoleEvents.platform, platform), eq(metaAppRoleEvents.accountId, accountId)),
    )
    .orderBy(desc(metaAppRoleEvents.at))
    .limit(READ_LIMIT);

  return defaultAppSinceFrom(platform, events, appId);
}
