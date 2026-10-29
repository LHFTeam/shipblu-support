import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, groupMembers, groups } from '@/db/schema';
import { uuidList } from '@/lib/http/form-data';
import { isUuid } from '@/lib/http/uuid';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Who is in which group, written from three places: an invite, the group's
 * editor and the agent's editor.
 *
 * Membership is load-bearing rather than a label. Auto-assignment hands a
 * group's tickets only to its members (`loadRoster`), and an agent-role user
 * sees only the tickets of the groups they are in plus what is assigned to
 * them or on a WhatsApp number they own (`heldByOrInGroupsOf`) — so an agent
 * in no group who owns no number opens the console to an empty inbox. Both
 * readers ask the table on every request, so a change here takes effect at the
 * next page and the next assignment, with no session to renew.
 */

/**
 * What a membership picker asked for: the boxes it drew ticked, and the boxes
 * ticked when it was sent.
 *
 * A save writes only the difference — a box unticked removes that pair, a box
 * ticked adds it — and a box nobody touched leaves the row as it is now,
 * whatever it was when the page was drawn. The two editors are on different
 * pages and either can sit open for a while, so writing the ticked set
 * wholesale, the way the skills editor writes its holders, would undo whatever
 * the other page saved meanwhile; and so would diffing against every box
 * drawn, since a box drawn unticked and left alone would remove a membership
 * the other page has since added. It also leaves alone everybody the form drew
 * no box for: the group editor has none for a deactivated agent who is not a
 * member, and the roster keeps a deactivated member's row on purpose, because
 * reactivating them puts them back where they were.
 */
export type MembershipChoice = { held: string[]; chosen: string[] };

/**
 * A picker's two halves out of a form: the ticked boxes under `name`, and a
 * hidden `${name}Held` for each box drawn ticked. Null when an id is not a
 * uuid, for `uuidList`'s reason.
 */
export function membershipChoice(formData: FormData, name: string): MembershipChoice | null {
  const chosen = uuidList(formData, name);
  const held = uuidList(formData, `${name}Held`);
  if (!chosen || !held) return null;
  return { held, chosen };
}

/**
 * Whether a choice changes any membership at all — the question the agent
 * editor's permission check asks, since an admin may save a name without being
 * allowed to touch anybody's groups.
 */
export function changesMembership(choice: MembershipChoice): boolean {
  const { added, dropped } = changes(choice);
  return added.length > 0 || dropped.length > 0;
}

/** The pairs a choice adds and the pairs it removes. */
function changes(choice: MembershipChoice): { added: string[]; dropped: string[] } {
  return {
    added: choice.chosen.filter((id) => !choice.held.includes(id)),
    dropped: choice.held.filter((id) => !choice.chosen.includes(id)),
  };
}

/**
 * The groups of these that exist, key-share locked until the transaction ends.
 *
 * The lock is what makes "it exists" still true at the insert: a group deleted
 * in between would otherwise raise 23503 out of the action instead of a
 * sentence. `deleteGroupIfUnused` takes the row's lock before deleting, so it
 * waits for this transaction and then finds the new members, which its
 * cascade removes with the group — the outcome either order would have had.
 */
async function liveGroupIds(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: groups.id })
    .from(groups)
    .where(inArray(groups.id, ids))
    .for('key share');
  return rows.map((row) => row.id);
}

/**
 * Puts an agent in each of these groups that still exists, leaving any they
 * are already in alone.
 *
 * For accepting an invite. Its group ids were checked when it was created and
 * have sat in jsonb since, where no foreign key holds them — so a group
 * deleted in the week the link was live is skipped rather than failing the
 * acceptance, which would leave a person who did everything right unable to
 * sign in. Anything not shaped like a uuid is skipped for the same reason:
 * Postgres raises 22P02 on one, and the column takes whatever was written to it.
 */
export async function joinGroups(tx: Tx, agentId: string, groupIds: unknown[]): Promise<void> {
  const live = await liveGroupIds(
    tx,
    groupIds.filter((id): id is string => isUuid(id)).map((id) => id.toLowerCase()),
  );
  if (live.length === 0) return;
  await tx
    .insert(groupMembers)
    .values(live.map((groupId) => ({ groupId, agentId })))
    .onConflictDoNothing();
}

/**
 * Applies the agent editor's groups to one agent.
 *
 * False, having written nothing, when a group it ticks has since been deleted
 * — the form is out of date, and saving the rest would read as somebody having
 * unticked it. Call it before anything else the transaction writes, so the
 * refusal leaves nothing to undo.
 */
export async function applyAgentGroups(
  tx: Tx,
  agentId: string,
  choice: MembershipChoice,
): Promise<boolean> {
  const { added, dropped } = changes(choice);
  const live = await liveGroupIds(tx, added);
  if (live.length !== added.length) return false;

  if (dropped.length > 0) {
    await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.agentId, agentId), inArray(groupMembers.groupId, dropped)));
  }
  if (live.length > 0) {
    await tx
      .insert(groupMembers)
      .values(live.map((groupId) => ({ groupId, agentId })))
      .onConflictDoNothing();
  }
  return true;
}

/**
 * Whether every agent a group editor newly ticked exists. Asked before the
 * group is written, because a new group has no id until it is.
 *
 * Existence, not activity. A stale form that ticks somebody deactivated since
 * adds a row the roster already ignores, which is what deactivation leaves
 * behind for every member anyway. Nothing deletes an agent, so the answer holds
 * until the insert without a lock.
 */
export async function agentsExist(choice: MembershipChoice): Promise<boolean> {
  const { added } = changes(choice);
  if (added.length === 0) return true;
  const rows = await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, added));
  return rows.length === added.length;
}

/** Applies the group editor's members to one group; `agentsExist` first. */
export async function applyGroupMembers(
  tx: Tx,
  groupId: string,
  choice: MembershipChoice,
): Promise<void> {
  const { added, dropped } = changes(choice);
  if (dropped.length > 0) {
    await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.agentId, dropped)));
  }
  if (added.length > 0) {
    await tx
      .insert(groupMembers)
      .values(added.map((agentId) => ({ groupId, agentId })))
      .onConflictDoNothing();
  }
}
