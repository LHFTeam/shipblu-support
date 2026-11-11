import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A lock on a ticket's row is FOR NO KEY UPDATE: FOR UPDATE is the one lock
 * the KEY SHARE of a message inserted for the ticket refuses, and taken after
 * a write of its own transaction it deadlocks with an ingest storing a message
 * there (§6.106, §6.116). Only a function that deletes the ticket takes it.
 */

/** Ten modules locking a ticket the right way: the rule's floor. */
const LOCKED = many(
  10,
  (i) => `lib/locked${i}.ts`,
  (i) =>
    `export const read${i} = (tx, id) => tx.select().from(conversations).where(id).for('no key update');\n`,
);

/** A module whose body is `lines`, the first on line 1. */
const source = (...lines) => `${lines.join('\n')}\n`;

const at = (line) =>
  expect.objectContaining({ rule: 'ticket-lock', where: `lib/tickets/lock.ts:${line}` });

const run = (files) => runRule('ticket-lock', { ...LOCKED, ...files });

describe('ticket-lock', () => {
  it("passes NO KEY UPDATE, another table's FOR UPDATE, and a lock that names only another table", async () => {
    const found = await run({
      'lib/tickets/lock.ts': source(
        "export const a = (tx, id) => tx.select().from(conversations).where(id).for('no key update');",
        "export const b = (tx, id) => tx.select().from(channels).where(id).for('update');",
        "export const c = (tx, id) => tx.select().from(conversations).innerJoin(channels, on).for('update', { of: channels });",
        "export const d = (tx, id) => tx.select().from(conversations).where(id).for('key share');",
        'export const e = (tx, id) => tx`select id from ${conversations} where id = ${id} for no key update`;',
        'export const f = (tx, id) => tx`select id from channels where id = ${id} for update`;',
        // Prose about the rule is not the rule broken.
        "// as .from(conversations).for('update') did, before §6.116",
        "export const g = 'select id from conversations for update, in a string';",
      ),
    });

    expect(found).toEqual([]);
  });

  it("refuses FOR UPDATE on a ticket's row, by the builder or in SQL, and names its line", async () => {
    const found = await run({
      'lib/tickets/lock.ts': source(
        "export const a = (tx, id) => tx.select().from(conversations).where(id).for('update');",
        "export const b = (tx, id) => tx.select().from(messages).innerJoin(conversations, on).for('update');",
        "export const c = (tx, id) => tx.select().from(conversations).for('update', { of: conversations });",
        "export const d = (tx, id) => tx.select().from(conversations).for('update', { of: [channels, conversations] });",
        "export const e = (tx, id) => tx.select().from(schema.conversations).where(id).for('update');",
        'export const f = (tx, id) => tx`select id from ${conversations} where id = ${id} for update`;',
        'export const g = (tx, id) => sql`select 1 from conversations where id = ${id} FOR UPDATE`;',
      ),
    });

    expect(found).toEqual([at(1), at(2), at(3), at(4), at(5), at(6), at(7)]);
    expect(found[0].message).toMatch(/FOR NO KEY UPDATE.*KEY SHARE.*§6\.106, §6\.116/);
  });

  // `readTicket` in Jev's classifier builds its read and locks it on one arm.
  it('follows a builder kept in a variable to its declaration', async () => {
    const found = await run({
      'lib/tickets/lock.ts': source(
        'export async function read(tx, id, lock) {',
        '  const query = tx.select().from(conversations).where(id).limit(1);',
        "  return lock ? await query.for('update') : await query;",
        '}',
      ),
    });

    expect(found).toEqual([at(3)]);
  });

  // `purgeConversation`: its lock keeps a message out between what it counts
  // and the delete.
  it('lets a function that deletes the ticket take FOR UPDATE', async () => {
    const found = await run({
      'lib/tickets/lock.ts': source(
        'export const purge = (id) => db.transaction(async (tx) => {',
        "  await tx.select().from(conversations).where(id).for('update');",
        '  await tx.delete(conversations).where(id);',
        '});',
        'export const purgeInSql = (id) => db.transaction(async (tx) => {',
        '  await tx`select id from conversations where id = ${id} for update`;',
        '  await tx`delete from ${conversations} where id = ${id}`;',
        '});',
      ),
    });

    expect(found).toEqual([]);
  });

  it('does not let a delete in another function excuse the lock', async () => {
    const found = await run({
      'lib/tickets/lock.ts': source(
        'export async function lock(tx, id) {',
        "  await tx.select().from(conversations).where(id).for('update');",
        '}',
        'export async function remove(tx, id) {',
        '  await tx.delete(conversations).where(id);',
        '}',
      ),
    });

    expect(found).toEqual([at(2)]);
  });

  // A test holds a ticket however the race it stages needs.
  it('leaves tests alone', async () => {
    const found = await run({
      'lib/tickets/lock.db.test.ts': source(
        "export const held = (tx, id) => tx.select().from(conversations).where(id).for('update');",
      ),
      'lib/testing/hold.ts': source(
        'export const held = (tx, id) => tx`select id from conversations where id = ${id} for update`;',
      ),
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few locks to be reading the builder', async () => {
    const found = await runRule('ticket-lock', {
      'lib/tickets/lock.ts': source(
        "export const a = (tx, id) => tx.select().from(conversations).where(id).for('no key update');",
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({ rule: 'ticket-lock', where: '(repository)' }),
    ]);
    expect(found[0].message).toMatch(/found only 1 locks on a ticket's row/);
  });
});
