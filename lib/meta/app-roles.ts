import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { metaAppRoleEvents } from '@/db/schema';
import { env } from '@/lib/env';
import { configuredAccountId } from './client';
import type { DefaultAppStanding, MetaPlatform, NormalisedAppRole } from './types';

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

const NO_STANDING: DefaultAppStanding = { since: null, lostAt: null };

/**
 * One fact per account that changes a few times a year, read by every
 * Instagram ticket render, reply, take-control press and `send_meta` job — so
 * memoised for thirty seconds per process, as `lib/presence/policy.ts` is.
 * Recording a new event here forgets it, so the worker that stored a switch
 * weighs it at once; another process sees it within the thirty seconds, which
 * is the trade. An error is not cached, so the next read tries again.
 */
const STANDING_TTL_MS = 30_000;
let standingMemo = new Map<string, { at: number; value: DefaultAppStanding }>();

/** Drop the memo: after a write here, and between database tests. */
export function forgetDefaultAppStanding(): void {
  standingMemo = new Map();
}

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

  if (rows.length > 0) forgetDefaultAppStanding();
  return rows.length > 0;
}

export type AppRoleEvent = { appId: string; roles: string[]; at: Date };

/**
 * Where this app stands as the account's default app, in the sense that moves
 * threads: since when it has been the default without a break, or since when
 * it has not been.
 *
 * Read newest first. The newest event that names this app, or names another
 * app the default, is the newest switch. If it gives this app `default_app`,
 * `since` is the start of the stretch: going back, the stretch ends at an event
 * giving this app no `default_app`, or one giving it to another app, and the
 * answer is the oldest event of this app's inside it. The start, not the latest
 * event of it: a message received in `standby` between the switch and a later
 * event that still names this app the default says another app took that
 * thread in the meantime, and a second statement of the same role is no
 * evidence that it gave the thread back.
 *
 * If the newest switch gives this app no `default_app`, or gives it to another
 * app, `lostAt` is that switch: by the same evidence that a switch to this app
 * moved the threads open at the time (`docs/PROJECT-STATE.md` §6.111), a switch
 * away moves them to the new default, and a reply to a customer who last wrote
 * before it would be refused `2534037`.
 *
 * Both null whenever there is nothing to go on — no app id, no event, Messenger
 * (`DEFAULT_APP_OWNS_THREADS`) — so a ticket is judged by its messages alone, as
 * it was before the switch was stored.
 */
export function defaultAppStandingFrom(
  platform: MetaPlatform,
  events: AppRoleEvent[],
  appId: string | null,
): DefaultAppStanding {
  if (!DEFAULT_APP_OWNS_THREADS[platform] || !appId) return NO_STANDING;

  const newestFirst = [...events].sort((a, b) => b.at.getTime() - a.at.getTime());
  const isDefault = (event: AppRoleEvent) => event.roles.includes(DEFAULT_APP);
  const isSwitch = (event: AppRoleEvent) => event.appId === appId || isDefault(event);

  const newest = newestFirst.find(isSwitch);
  if (!newest) return NO_STANDING;
  if (newest.appId !== appId || !isDefault(newest)) return { since: null, lostAt: newest.at };

  let since = newest.at;
  for (const event of newestFirst.slice(newestFirst.indexOf(newest) + 1)) {
    if (!isSwitch(event)) continue;
    if (event.appId !== appId || !isDefault(event)) break;
    since = event.at;
  }
  return { since, lostAt: null };
}

/**
 * `defaultAppStandingFrom` over the stored events for the account this
 * deployment sends from — the only account whose threads the verdict judges by
 * it, since a message received on another is refused as `other_account` first.
 *
 * Messenger answers nothing without a query (`DEFAULT_APP_OWNS_THREADS`), and an
 * Instagram answer is memoised (`STANDING_TTL_MS`).
 */
export async function defaultAppStanding(platform: MetaPlatform): Promise<DefaultAppStanding> {
  if (!DEFAULT_APP_OWNS_THREADS[platform]) return NO_STANDING;

  const appId = env().META_APP_ID || null;
  const accountId = configuredAccountId(platform);
  if (!appId || !accountId) return NO_STANDING;

  const key = `${platform}|${accountId}|${appId}`;
  const memo = standingMemo.get(key);
  if (memo && Date.now() - memo.at < STANDING_TTL_MS) return memo.value;

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

  const value = defaultAppStandingFrom(platform, events, appId);
  standingMemo.set(key, { at: Date.now(), value });
  return value;
}
