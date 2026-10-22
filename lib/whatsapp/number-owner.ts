import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  channelOwnerChanges,
  channels,
  conversationEvents,
  conversations,
  ticketStatuses,
} from '@/db/schema';
import type { StatusCategory } from '@/lib/tickets/vocabulary';
import { parseCoexistence } from './coexistence';

/**
 * A WhatsApp number that belongs to a person, and the tickets that follow it.
 *
 * The team hands a business number to one member, who then answers its
 * customers from the phone and answers for its tickets' SLA. Two columns carry
 * that, and they say different things: `channels.owner_agent_id` is who owns
 * the number *now*, and `conversations.accountable_agent_id` is who a ticket's
 * breaches count against, frozen onto the ticket because ownership changes and
 * the nightly rollup rebuilds the last three days from current state.
 *
 * Every write of either column is in this module, so the three moments a
 * ticket's accountability may move are one file to read: ingest creating a
 * ticket on an owned number (`lockedOwnerId` and `ownerStamp`), a handover
 * (`handOverNumber`), and a customer reopening a ticket after one
 * (`alignAccountable`). Nothing else — not assignment, reclaim, a supervisor's
 * reassignment, an automation or a merge — touches accountability, which is
 * what lets a reassignment move the work and leave the breach with the person
 * responsible for the number.
 *
 * The events written here carry no `actorAgentId`, a handover's included. The
 * agent rollup counts every event an agent is the actor of as a ticket they
 * touched, and an admin handing over a number with ninety open tickets has not
 * worked ninety tickets; the admin is named in the event's `by` and in
 * `channel_owner_changes` instead.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A number's owner as its row records them, active or not. */
export type NumberOwner = { id: string; active: boolean };

/**
 * Who a number's new tickets belong to: its owner while they are active, and
 * nobody otherwise.
 *
 * A deactivated owner stays on the number so reactivating them restores it, but
 * stamping new work on somebody who cannot sign in would hand every new ticket
 * on the number to a person who cannot answer it, and charge them its breaches.
 * Nobody means the number behaves as a team number until an admin hands it
 * over: the group's rota assigns, and reports fall back to the assignee.
 */
export function effectiveOwnerId(owner: NumberOwner | null): string | null {
  return owner?.active ? owner.id : null;
}

/**
 * Who a ticket about to be created or reopened on this number belongs to — the
 * row's `effectiveOwnerId` — read inside the caller's transaction, before it
 * writes any conversation row.
 *
 * Under FOR KEY SHARE, which is the lock the new ticket's own foreign key check
 * takes on the row anyway, so it holds up nothing an ordinary edit of the
 * channel does: it conflicts only with a handover's FOR UPDATE. Read before the
 * transaction instead, a message arriving as the number changes hands is
 * stamped with the previous owner after the handover has already collected the
 * number's tickets — one ticket left with somebody who no longer has the phone,
 * and no way to move it, since handing the number to the person who already
 * owns it changes nothing. Taken here, either the handover waits for this
 * ticket and moves it, or this waits for the handover and reads its owner.
 *
 * Null for a row that is not a plain number: the bot is nobody's.
 */
export async function lockedOwnerId(tx: Tx, channelId: string): Promise<string | null> {
  // The channel alone, and the owner in a second read. A row that waited for a
  // handover's lock is re-read at its new version, but a table joined to it and
  // not locked keeps the row the first look found — the previous owner's —
  // so a join here reads the new owner as matching nobody, and so as inactive.
  const [row] = await tx
    .select({ type: channels.type, ownerId: channels.ownerAgentId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .for('key share');
  if (!row || row.type !== 'whatsapp' || !row.ownerId) return null;

  const [owner] = await tx
    .select({ active: agents.isActive })
    .from(agents)
    .where(eq(agents.id, row.ownerId));
  return effectiveOwnerId(owner ? { id: row.ownerId, active: owner.active } : null);
}

/**
 * The columns a ticket created on a number starts with: accountable to the
 * owner and assigned to them, at `at` — or neither, with no owner.
 *
 * Written in the insert rather than by the assignment that follows it, because
 * an `on_create` rule must see the ticket the team actually has, and because a
 * ticket the business opened from the phone is resolved on creation and never
 * reaches `assignConversation` at all. `autoAssign` then finds it assigned and
 * stops there.
 */
export function ownerStamp(
  ownerId: string | null,
  at: Date,
): {
  accountableAgentId: string | null;
  assigneeAgentId: string | null;
  assignedAt: Date | null;
} {
  return ownerId
    ? { accountableAgentId: ownerId, assigneeAgentId: ownerId, assignedAt: at }
    : { accountableAgentId: null, assigneeAgentId: null, assignedAt: null };
}

/**
 * The timeline's record that a ticket went to its number's owner — beside the
 * insert `ownerStamp` filled, or where `assignConversation` hands an owned
 * ticket back. No actor agent, because nobody chose it; the label names the
 * mechanism, as the assignment module's events do.
 */
export async function recordOwnerAssigned(
  tx: Pick<Tx, 'insert'>,
  input: {
    conversationId: string;
    ownerId: string;
    channelId: string | null;
    actorLabel?: string;
  },
): Promise<void> {
  await tx.insert(conversationEvents).values({
    conversationId: input.conversationId,
    type: 'assigned',
    actorLabel: input.actorLabel ?? 'number_owner',
    data: { to: input.ownerId, reason: 'number_owner', channelId: input.channelId },
  });
}

/** Why a ticket's accountability was brought in line with its number. */
/**
 * Why a ticket was realigned: its customer reopened it (WhatsApp ingest or the
 * portal), or an agent or a rule moved it out of resolved. Two reasons rather
 * than one so the timeline can say which happened.
 */
export type AlignReason = 'reopened_after_handover' | 'reopened_by_status';

/**
 * The owner a ticket takes when it is moved out of resolved anywhere but
 * WhatsApp ingest — an agent's status picker, a rule's `set_status`, a reply
 * through the help-centre portal — or null when this move realigns nothing.
 *
 * The customer writing on WhatsApp is not the only way a resolved ticket comes
 * back, and after any of the others the customer's next message continues an
 * open ticket, which never realigns. Left to
 * ingest alone, a ticket resolved across a handover and reopened by hand stays
 * with the previous owner for good: Unassign hands it back to them, the sweep
 * never reclaims it from them, and handing the number to the person who owns it
 * now changes nothing. Only out of resolved, as the customer's reopen: closed
 * and imported tickets stay where a handover leaves them.
 *
 * Call it before writing the status, inside the same transaction, so the
 * channel's lock is taken before the ticket's — the order a handover takes
 * them — and pass the answer to `alignAccountable` afterwards.
 */
export async function ownerOnReopen(
  tx: Tx,
  conversationId: string,
  to: StatusCategory,
): Promise<{ ownerId: string | null; channelId: string } | null> {
  if (to !== 'open' && to !== 'pending') return null;

  const [ticket] = await tx
    .select({
      channel: conversations.channel,
      channelId: conversations.channelId,
      sourceSystem: conversations.sourceSystem,
      category: ticketStatuses.category,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, conversationId));

  if (
    !ticket?.channelId ||
    ticket.channel !== 'whatsapp' ||
    ticket.sourceSystem === 'import' ||
    ticket.category !== 'resolved'
  ) {
    return null;
  }
  return { ownerId: await lockedOwnerId(tx, ticket.channelId), channelId: ticket.channelId };
}

/**
 * Bring a ticket back in line with its number's owner, when a customer reopens
 * it.
 *
 * A handover moves the number's open and pending tickets and leaves resolved
 * ones alone, because most never come back and rewriting a finished ticket's
 * accountability would move a breach that already happened. The few that do
 * come back are moved here, at the moment the customer writes again: the chats
 * went with the phone, so the previous owner cannot answer it any more.
 *
 * A no-op on nearly every reopen, since the number has not changed hands. When
 * it has, the assignee moves too, but only off the previous accountable person
 * or nobody — a ticket a supervisor gave to a third person stays with them, as
 * it does in a handover. With the number now nobody's (cleared, or its owner
 * deactivated) the accountability clears and the assignee stays: the ticket is
 * then a team ticket like any other, which keeps the assignee it had.
 */
export async function alignAccountable(
  tx: Tx,
  input: {
    conversationId: string;
    ownerId: string | null;
    channelId: string | null;
    reason: AlignReason;
    now?: Date;
  },
): Promise<{ changed: boolean; reassigned: boolean }> {
  const [ticket] = await tx
    .select({
      accountableAgentId: conversations.accountableAgentId,
      assigneeAgentId: conversations.assigneeAgentId,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .for('update');

  if (!ticket || ticket.accountableAgentId === input.ownerId) {
    return { changed: false, reassigned: false };
  }

  const reassign = movesAssignee(ticket, ticket.accountableAgentId, input.ownerId);

  await tx
    .update(conversations)
    .set({
      accountableAgentId: input.ownerId,
      ...(reassign ? { assigneeAgentId: input.ownerId, assignedAt: input.now ?? new Date() } : {}),
    })
    .where(eq(conversations.id, input.conversationId));

  await tx.insert(conversationEvents).values({
    conversationId: input.conversationId,
    type: 'accountable_changed',
    actorLabel: 'number_owner',
    data: {
      from: ticket.accountableAgentId,
      to: input.ownerId,
      channelId: input.channelId,
      reason: input.reason,
    },
  });

  if (reassign && input.ownerId) {
    await recordOwnerAssigned(tx, {
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      channelId: input.channelId,
    });
  }

  return { changed: true, reassigned: reassign };
}

/**
 * Whether a ticket's assignee follows its accountability to `to`: only when
 * there is somebody to follow it to, and the ticket was with the person it is
 * moving from or with nobody. Anybody else holding it was put there on purpose.
 */
function movesAssignee(
  ticket: { assigneeAgentId: string | null },
  from: string | null,
  to: string | null,
): boolean {
  if (!to || ticket.assigneeAgentId === to) return false;
  return ticket.assigneeAgentId === null || ticket.assigneeAgentId === from;
}

/**
 * The tickets on a number that move with it: open and pending, native, and
 * still a ticket. Resolved ones follow only if their customer writes again
 * (`alignAccountable`); closed ones are finished; a copied history is a record
 * nobody answers. One copy, so the count the admin is shown before the second
 * click is the set the handover then moves. The caller adds which numbers.
 */
function movesWithNumber() {
  return and(
    ne(conversations.sourceSystem, 'import'),
    isNull(conversations.deletedAt),
    isNull(conversations.mergedIntoId),
    eq(conversations.isSpam, false),
    // A subquery rather than a join, so the handover's FOR UPDATE locks the
    // tickets and not the status rows — a lock on those would hold up every
    // insert of a ticket in that status, whose foreign key check takes a share
    // lock on them, for as long as the handover ran.
    inArray(
      conversations.statusId,
      db
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(inArray(ticketStatuses.category, ['open', 'pending'])),
    ),
  );
}

/** Who did the handover: the admin, by id and by name as it reads today. */
export type HandoverActor = { id: string; label: string };

export type Handover =
  | { ok: false; error: string }
  | {
      ok: true;
      /** False when the number already belonged to that person: nothing was written. */
      changed: boolean;
      channelName: string;
      /** As Meta displays the number, where the row records it (a coexistence number). */
      displayNumber: string | null;
      /** The new owner, or null for a team number. */
      to: { id: string; label: string } | null;
      /** Open and pending tickets now accountable to `to`. */
      ticketsMoved: number;
      /** Of those, the ones whose assignee moved to `to` as well. */
      ticketsReassigned: number;
    };

/**
 * Hand a WhatsApp number to a team member — a first owner, a change of owner,
 * cover for leave — or back to the team with `toAgentId` null.
 *
 * One transaction, so "who owns the number" and "who answers for its open
 * tickets" cannot be read disagreeing. The channel row is locked first, and
 * ingest reads the owner under a lock that waits for this one
 * (`lockedOwnerId`), so a ticket arriving mid-handover is either stamped with
 * the old owner and committed before the select below, which then moves it, or
 * stamped with the new one.
 *
 * The open and pending tickets become the new owner's to answer for. Their
 * assignee moves too, but only where it was the previous owner or nobody: a
 * ticket a supervisor deliberately gave to somebody else stays with them, and
 * its breach still counts against the new owner. Handing a number to nobody
 * clears the accountability and moves no work; the assignees keep what they
 * hold.
 *
 * Refused, with a sentence for the admin, when the channel is gone or is not a
 * plain WhatsApp number (`channels_owner_only_whatsapp` refuses it below this
 * too), and when the new owner is unknown or deactivated — stamping work on
 * somebody who cannot sign in is what `effectiveOwnerId` exists to avoid. A
 * handover to the person who already owns the number writes nothing, the audit
 * row included, so a double submit does not read as two handovers.
 */
export async function handOverNumber(input: {
  channelId: string;
  toAgentId: string | null;
  actor: HandoverActor;
}): Promise<Handover> {
  const now = new Date();

  return db.transaction(async (tx): Promise<Handover> => {
    // FOR UPDATE, and not left to the update below: an update that changes no
    // key takes a lock ingest's FOR KEY SHARE does not wait for, so only this
    // one makes a ticket being created on the number wait (`lockedOwnerId`).
    const [channel] = await tx
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        config: channels.config,
        ownerAgentId: channels.ownerAgentId,
      })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .for('update');

    if (!channel) return { ok: false, error: 'That channel no longer exists.' };
    if (channel.type !== 'whatsapp') {
      return {
        ok: false,
        error:
          'Only a WhatsApp number can belong to a person. The bot and the shared inboxes are answered by the whole team.',
      };
    }

    // Re-read rather than trusted from the form: the picker was drawn from a
    // list that may be minutes old.
    let to: { id: string; label: string } | null = null;
    if (input.toAgentId) {
      const [agent] = await tx
        .select({
          id: agents.id,
          name: agents.name,
          email: agents.email,
          isActive: agents.isActive,
        })
        .from(agents)
        .where(eq(agents.id, input.toAgentId));
      if (!agent) return { ok: false, error: 'That agent no longer exists.' };
      const label = agentLabel(agent);
      if (!agent.isActive) {
        return {
          ok: false,
          error: `${label} is deactivated. Reactivate them before handing them a number.`,
        };
      }
      to = { id: agent.id, label };
    }

    const displayNumber = parseCoexistence(channel.config)?.displayPhoneNumber ?? null;
    const unchanged = {
      ok: true as const,
      changed: false,
      channelName: channel.name,
      displayNumber,
      to,
      ticketsMoved: 0,
      ticketsReassigned: 0,
    };
    if (channel.ownerAgentId === (to?.id ?? null)) return unchanged;

    const from = channel.ownerAgentId;
    const [previous] = from
      ? await tx
          .select({ name: agents.name, email: agents.email })
          .from(agents)
          .where(eq(agents.id, from))
      : [];

    await tx
      .update(channels)
      .set({ ownerAgentId: to?.id ?? null, updatedAt: now })
      .where(eq(channels.id, channel.id));

    const tickets = await tx
      .select({
        id: conversations.id,
        accountableAgentId: conversations.accountableAgentId,
        assigneeAgentId: conversations.assigneeAgentId,
      })
      .from(conversations)
      .where(and(eq(conversations.channelId, channel.id), movesWithNumber()))
      .for('update');

    const moved = tickets.filter((ticket) => ticket.accountableAgentId !== (to?.id ?? null));
    const reassigned = to
      ? tickets.filter((ticket) => movesAssignee(ticket, from, to.id)).map((ticket) => ticket.id)
      : [];

    if (moved.length > 0) {
      await tx
        .update(conversations)
        .set({ accountableAgentId: to?.id ?? null })
        .where(
          inArray(
            conversations.id,
            moved.map((ticket) => ticket.id),
          ),
        );
    }
    if (to && reassigned.length > 0) {
      await tx
        .update(conversations)
        .set({ assigneeAgentId: to.id, assignedAt: now })
        .where(inArray(conversations.id, reassigned));
    }

    const [change] = await tx
      .insert(channelOwnerChanges)
      .values({
        channelId: channel.id,
        channelName: channel.name,
        displayNumber,
        fromAgentId: from,
        fromLabel: previous ? agentLabel(previous) : null,
        toAgentId: to?.id ?? null,
        toLabel: to?.label ?? null,
        changedByAgentId: input.actor.id,
        changedByLabel: input.actor.label,
        ticketsMoved: moved.length,
        ticketsReassigned: reassigned.length,
        createdAt: now,
      })
      .returning({ id: channelOwnerChanges.id });

    // `by` names the admin where the actor column would have, for the reason
    // the module header gives; `changeId` ties each line on a ticket's
    // timeline to the one handover that wrote it.
    const stamp = {
      channelId: channel.id,
      reason: 'number_handover',
      by: input.actor.id,
      changeId: change!.id,
    };
    const events: (typeof conversationEvents.$inferInsert)[] = [
      ...moved.map((ticket) => ({
        conversationId: ticket.id,
        type: 'accountable_changed',
        actorLabel: 'number_handover',
        data: { from: ticket.accountableAgentId, to: to?.id ?? null, ...stamp },
        createdAt: now,
      })),
      ...reassigned.map((id) => ({
        conversationId: id,
        type: 'assigned',
        actorLabel: 'number_handover',
        data: { to: to!.id, ...stamp },
        createdAt: now,
      })),
    ];
    if (events.length > 0) await tx.insert(conversationEvents).values(events);

    return {
      ...unchanged,
      changed: true,
      ticketsMoved: moved.length,
      ticketsReassigned: reassigned.length,
    };
  });
}

/**
 * What the admin reads once a handover has answered: who answers for the
 * number now, and what that did to its tickets. The form said how many would
 * go; this says what did, and ninety tickets changing hands is the part
 * somebody will be asked about later.
 *
 * Two counts where they differ, because they differ for a reason: a ticket a
 * supervisor gave to a third person now counts against the new owner and stays
 * with whoever it was given to, so "moved to them" would be true of its breach
 * and false of its work. A handover that changed nothing says so, because a
 * second press of the button lands here and must not read as a second handover.
 */
export function handoverNotice(done: Extract<Handover, { ok: true }>): string {
  const number = done.displayNumber ?? done.channelName;
  const one = done.ticketsMoved === 1;
  const moved = `${done.ticketsMoved} open or pending ${one ? 'ticket' : 'tickets'}`;
  const counts = one ? 'counts' : 'count';

  if (!done.changed) {
    return done.to
      ? `${done.to.label} already owns ${number}; nothing changed.`
      : `${number} is already a team number; nothing changed.`;
  }

  if (!done.to) {
    return done.ticketsMoved === 0
      ? `${number} is a team number from now.`
      : `${number} is a team number from now: its ${moved} ${counts} against whoever holds ${one ? 'it' : 'each'}.`;
  }

  const owns = `${done.to.label} owns ${number} from now.`;
  const reassigned = done.ticketsReassigned === 1 ? 'was' : 'were';
  if (done.ticketsMoved === 0) {
    // None needed its accountability moved, yet some changed hands: a
    // ticket can already count against the new owner only if an agent
    // reopened it by hand after an earlier handover away from them, and it
    // follows them when nobody, or the previous owner, held it.
    return done.ticketsReassigned === 0
      ? `${owns} No open or pending ticket needed moving.`
      : `${owns} ${done.ticketsReassigned} open or pending ${done.ticketsReassigned === 1 ? 'ticket' : 'tickets'} ${reassigned} reassigned to them.`;
  }
  if (done.ticketsReassigned === done.ticketsMoved) return `${owns} ${moved} moved to them.`;
  if (done.ticketsReassigned === 0) {
    return `${owns} ${moved} ${counts} against them, and ${one ? 'stays' : 'stay'} with whoever holds ${one ? 'it' : 'them'}.`;
  }
  return `${owns} ${moved} count against them; ${done.ticketsReassigned} ${reassigned} reassigned to them, and the rest stay with whoever holds them.`;
}

/** How a person is named in the record: their name, or their address when it is blank. */
function agentLabel(agent: { name: string; email: string }): string {
  return agent.name.trim() || agent.email;
}

/** One handover, as the admin page lists it. */
export type OwnerChange = {
  id: string;
  fromLabel: string | null;
  /** Null for a handover back to the team. */
  toLabel: string | null;
  changedByLabel: string | null;
  ticketsMoved: number;
  ticketsReassigned: number;
  createdAt: Date;
};

export type NumberOwnership = {
  channelId: string;
  /** Null for a team number. A deactivated owner is still named, with `active` false. */
  owner: { id: string; label: string; active: boolean } | null;
  /** What a handover would move now: open and pending native tickets. */
  movableTickets: number;
  /**
   * The handover that left the number as it is — "since when, set by whom" —
   * or null when none did: a number nobody has handed over, or one whose
   * owner was set or removed some other way since.
   */
  current: OwnerChange | null;
  /** The handovers before it, newest first; with `current`, at most `HISTORY_SHOWN`. */
  earlier: OwnerChange[];
};

/** How many handovers the admin page lists per number. */
const HISTORY_SHOWN = 10;

/**
 * Every WhatsApp number's owner, what a handover would move, and who held it
 * before — the admin page's read, for the badge, the hint before the second
 * click, and "since when, set by whom".
 *
 * The history is read whole and cut per number in code rather than ranked in
 * SQL. A handover is a person changing jobs or going on leave, a few a year per
 * number, so the table stays small for as long as anybody will read this.
 *
 * The newest handover is `current` only when it names the owner the row has
 * now. `handOverNumber` is the only writer of the column, so it nearly always
 * does; the exceptions are an owner set by hand in the database, which leaves
 * no record, and an owner deleted since, whom the foreign key took off the row
 * and the record still names. In either case "since 14 Oct, set by Mona" would
 * date a state the number is not in, so the record is listed with the earlier
 * ones and the row says nothing about since when.
 */
export async function numberOwnership(): Promise<NumberOwnership[]> {
  const numbers = await db
    .select({
      channelId: channels.id,
      ownerId: agents.id,
      ownerName: agents.name,
      ownerEmail: agents.email,
      ownerActive: agents.isActive,
    })
    .from(channels)
    .leftJoin(agents, eq(agents.id, channels.ownerAgentId))
    .where(eq(channels.type, 'whatsapp'))
    .orderBy(asc(channels.name));

  if (numbers.length === 0) return [];
  const ids = numbers.map((row) => row.channelId);

  const counts = await db
    .select({ channelId: conversations.channelId, count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(and(inArray(conversations.channelId, ids), movesWithNumber()))
    .groupBy(conversations.channelId);

  const changes = await db
    .select({
      id: channelOwnerChanges.id,
      channelId: channelOwnerChanges.channelId,
      fromLabel: channelOwnerChanges.fromLabel,
      toAgentId: channelOwnerChanges.toAgentId,
      toLabel: channelOwnerChanges.toLabel,
      changedByLabel: channelOwnerChanges.changedByLabel,
      ticketsMoved: channelOwnerChanges.ticketsMoved,
      ticketsReassigned: channelOwnerChanges.ticketsReassigned,
      createdAt: channelOwnerChanges.createdAt,
    })
    .from(channelOwnerChanges)
    .where(inArray(channelOwnerChanges.channelId, ids))
    .orderBy(desc(channelOwnerChanges.createdAt), desc(channelOwnerChanges.id));

  return numbers.map((row) => {
    const history = changes
      .filter((change) => change.channelId === row.channelId)
      .slice(0, HISTORY_SHOWN);
    const newest = history[0];
    // A record naming nobody describes a team number only if it never named
    // anybody: a `to_label` with no `to_agent_id` is an owner since deleted.
    const isCurrent =
      newest !== undefined &&
      newest.toAgentId === row.ownerId &&
      (row.ownerId !== null || newest.toLabel === null);
    const shown = history.map(
      ({ channelId: _channelId, toAgentId: _toAgentId, ...change }): OwnerChange => change,
    );

    return {
      channelId: row.channelId,
      owner: row.ownerId
        ? {
            id: row.ownerId,
            label: agentLabel({ name: row.ownerName ?? '', email: row.ownerEmail ?? '' }),
            active: row.ownerActive ?? false,
          }
        : null,
      movableTickets: counts.find((count) => count.channelId === row.channelId)?.count ?? 0,
      current: isCurrent ? (shown[0] ?? null) : null,
      earlier: isCurrent ? shown.slice(1) : shown,
    };
  });
}
