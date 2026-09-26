/**
 * Whether a purge would destroy a ticket the admin pressing it cannot see.
 *
 * The ticket purge always went through `loadConversation()`, so an admin
 * without `ticket.view.bot` could not delete a bot transcript by opening it —
 * they cannot open it. But a purge reaches further than the row on screen: a
 * ticket takes the tickets merged into it, and a contact takes every ticket they
 * ever raised, plus those of the contacts folded into them. The contact page
 * lists those tickets through `conversationsForContact(agent, …)`, which hides
 * the bot channel, so the panel could count and then destroy a transcript the
 * admin was never shown and has no permission to read. A delete is the one place
 * where "you may not see it" has to mean "you may not remove it" as well.
 *
 * The scope is rebuilt here rather than borrowed from `lib/admin/purge.ts`
 * because that module's walk lives inside its transaction and is not exported;
 * the rule is the same one — tickets merged into the subject, followed
 * backwards and bounded, and contact tombstones one hop deep, as `contactScope`
 * does. If the two ever disagree it is in the direction of this check reaching
 * less than the purge, so keep them in step.
 *
 * It runs outside the purge's transaction, so a merge landing between this read
 * and the delete is not covered. That window is a second or two wide and needs
 * two admins racing on one record; closing it would mean moving the check into
 * `purge.ts`, which is a separate change.
 *
 * The SQL here runs from pages and actions, which CI's `database` job never
 * executes, so it is kept to drizzle builders over `inArray` — no raw fragment,
 * no cast, no enum comparison typed out by hand.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, conversations } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { canSeeChannel, hiddenChannels } from '@/lib/tickets/channel-policy';

export type PurgeScope = { conversationId: string } | { contactId: string };

/**
 * The channels among these that this agent may not see, each named once.
 *
 * The one decision in this module, kept pure so it can be tested without a
 * database, and phrased through `canSeeChannel` so it cannot drift from the rule
 * the inbox, the attachment route and the realtime topics already apply.
 */
export function unseenChannels(agent: SessionAgent, channels: readonly string[]): string[] {
  return [...new Set(channels)].filter((channel) => !canSeeChannel(agent, channel));
}

/** Same walk and the same bound as `withMergedInto()` in `./purge`. */
async function withMergedInto(ids: string[]): Promise<string[]> {
  const all = new Set(ids);
  let frontier = ids;

  for (let hop = 0; hop < 8 && frontier.length > 0; hop += 1) {
    const rows = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.mergedIntoId, frontier));

    frontier = rows.map((row) => row.id).filter((id) => !all.has(id));
    for (const id of frontier) all.add(id);
  }

  return [...all];
}

async function conversationIdsIn(scope: PurgeScope): Promise<string[]> {
  if ('conversationId' in scope) return withMergedInto([scope.conversationId]);

  const merged = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.mergedIntoContactId, scope.contactId));

  const owned = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      inArray(conversations.requesterContactId, [scope.contactId, ...merged.map((row) => row.id)]),
    );

  return withMergedInto(owned.map((row) => row.id));
}

/**
 * Why this agent may not purge this scope, or null when nothing stands in the
 * way.
 *
 * A sentence rather than a boolean so the panel on the page and the action
 * behind it refuse in the same words. It names no ticket and no count: those
 * would describe the very rows the agent is not allowed to know about.
 */
export async function hiddenScopeRefusal(
  agent: SessionAgent,
  scope: PurgeScope,
): Promise<string | null> {
  // Nothing to look up for an agent who can see every channel, which is every
  // admin unless an override removed `ticket.view.bot`.
  if (hiddenChannels(agent).length === 0) return null;

  const ids = await conversationIdsIn(scope);
  if (ids.length === 0) return null;

  const rows = await db
    .selectDistinct({ channel: conversations.channel })
    .from(conversations)
    .where(inArray(conversations.id, ids));

  if (
    unseenChannels(
      agent,
      rows.map((row) => row.channel),
    ).length === 0
  )
    return null;

  return 'contactId' in scope
    ? 'This customer has tickets on a channel you can’t see, so you can’t delete them. Ask an admin who can see every channel.'
    : 'A ticket merged into this one is on a channel you can’t see, so you can’t delete it. Ask an admin who can see every channel.';
}
