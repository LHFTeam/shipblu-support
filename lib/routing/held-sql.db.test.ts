import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, routingDecisions, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import { openBacklog } from '@/lib/tickets/backlog';
import { routingHold } from '@/lib/tickets/inbox-badges';
import { heldSql } from './held-sql';
import { isHeld, ROUTING_GRACE_MS } from './hold';

/**
 * The two spellings of the hold — `heldSql()` for a query, `isHeld()` over a
 * row in hand — held to the same answer on the same rows, as
 * `not-reaction.db.test.ts` holds its pair. The live board counts "being
 * routed" with one and the inbox draws "Routing…" with the other, so a row they
 * disagree on is a ticket the board calls routed and the inbox does not, or the
 * other way round.
 *
 * Every edge of the rule has a row: the window ahead, the window passed but the
 * grace not, the instant the grace runs out, the grace long gone, a decision, an
 * assignee, a ticket resolved or marked spam inside its window (held by the
 * columns, and not work), and a shadow ticket, whose window lives on its
 * `routing_decisions` row and never on the ticket's.
 */

withCleanDatabase();

const MINUTE = 60_000;
const NOW = cairo('2026-10-13T12:30');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

async function statusId(name: string) {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

/** Every case, by name, with the columns it is built from. */
async function fixtures() {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [holder] = await db
    .insert(agents)
    .values({ name: 'Nayera', email: 'nayera@shipblu.test', role: 'agent' })
    .returning({ id: agents.id });
  const open = await statusId('Open');
  const resolved = await statusId('Resolved');

  const cases: Record<string, Partial<typeof conversations.$inferInsert>> = {
    insideTheWindow: { routingWindowEndsAt: at(3 * MINUTE) },
    insideTheGrace: { routingWindowEndsAt: at(-5 * MINUTE) },
    // `now` equal to the window's end plus the grace: over, since the hold
    // lasts while now is *before* it.
    atTheGracesEnd: { routingWindowEndsAt: at(-ROUTING_GRACE_MS) },
    pastTheGrace: { routingWindowEndsAt: at(-11 * MINUTE) },
    decided: { routingWindowEndsAt: at(3 * MINUTE), routingDecidedAt: at(-MINUTE) },
    assigned: { routingWindowEndsAt: at(3 * MINUTE), assigneeAgentId: holder!.id },
    resolvedInItsWindow: { routingWindowEndsAt: at(3 * MINUTE), statusId: resolved },
    spamInItsWindow: { routingWindowEndsAt: at(3 * MINUTE), isSpam: true },
    shadow: {},
    neverRouted: {},
  };

  const ids: Record<string, string> = {};
  for (const [name, values] of Object.entries(cases)) {
    const [row] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        statusId: open,
        requesterContactId: contact!.id,
        subject: name,
        ...values,
      })
      .returning({ id: conversations.id });
    ids[name] = row!.id;
  }

  // A shadow decision runs to its job's due time with nothing held: the window
  // is on this row, and the ticket's own column stays null.
  await db.insert(routingDecisions).values({
    conversationId: ids.shadow!,
    shadow: true,
    windowEndsAt: at(3 * MINUTE),
    startedAt: at(-2 * MINUTE),
  });

  return ids;
}

/** Each fixture as `isHeld` and `routingHold` read it — the row in hand. */
async function rowsInHand() {
  return db
    .select({
      id: conversations.id,
      subject: conversations.subject,
      routingWindowEndsAt: conversations.routingWindowEndsAt,
      routingDecidedAt: conversations.routingDecidedAt,
      assigneeAgentId: conversations.assigneeAgentId,
      isSpam: conversations.isSpam,
      mergedIntoId: conversations.mergedIntoId,
      statusCategory: ticketStatuses.category,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId));
}

const names = (rows: { subject: string | null }[]) => rows.map((row) => row.subject).sort();

describe('heldSql and isHeld', () => {
  it('hold exactly the same rows', async () => {
    await fixtures();
    const inHand = await rowsInHand();

    const held = await db
      .select({ subject: conversations.subject })
      .from(conversations)
      .where(heldSql(NOW));

    expect(names(held)).toEqual(names(inHand.filter((row) => isHeld(row, NOW))));
    // And the rule is the one meant. Neither reads whether the ticket is work,
    // so the resolved and the spam ticket are held by the columns alone.
    expect(names(held)).toEqual(
      ['insideTheGrace', 'insideTheWindow', 'resolvedInItsWindow', 'spamInItsWindow'].sort(),
    );
  });

  it('over the open backlog, count what the inbox marks “Routing…”', async () => {
    await fixtures();
    const inHand = await rowsInHand();

    // The board's population: `queueSnapshot` counts the hold inside it.
    const counted = await db
      .select({ subject: conversations.subject })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
      .where(and(openBacklog(), heldSql(NOW)));

    const badged = inHand.filter((row) => routingHold(row, NOW) !== null);

    expect(names(counted)).toEqual(names(badged));
    expect(names(counted)).toEqual(['insideTheGrace', 'insideTheWindow']);
  });

  it('binds the instant as an ISO string behind a cast, never as a Date', () => {
    const { sql: text, params } = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(heldSql(NOW))
      .toSQL();

    // postgres.js cannot serialise a Date bound into a `sql` template, and an
    // EXPLAIN typed out by hand would not show it: the bug is in the binding.
    expect(params.some((param) => param instanceof Date)).toBe(false);
    expect(params).toContain(NOW.toISOString());
    expect(text).toContain('::timestamptz');
    // The grace comes from the constant, not from a number retyped in SQL.
    expect(params).toContain(ROUTING_GRACE_MS / 1000);
  });
});
