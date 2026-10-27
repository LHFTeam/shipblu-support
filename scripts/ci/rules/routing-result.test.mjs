import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A routing writer's answer says whether the ticket's category or group
 * changed, and so whether `afterRoutingChanged` is owed; a caller that drops it
 * cannot owe the follow-up correctly (Stage 4.0).
 */

/** Four modules keeping a writer's answer and owing for it: the rule's floor. */
const KEPT = many(
  4,
  (i) => `lib/kept${i}.ts`,
  (i) =>
    `export async function f${i}(id: string) {\n  const write = await setConversationCategory(id, null, { label: 'x' });\n  await afterRoutingChanged(id, { category: write.outcome === 'changed', group: false });\n}\n`,
);

const at = (line) =>
  expect.objectContaining({ rule: 'routing-result', where: `lib/writer.ts:${line}` });

const run = (files) => runRule('routing-result', { ...KEPT, ...files });

/** A module whose body is `lines`, the first on line 1. */
const body = (...lines) => `${lines.join('\n')}\n`;

describe('routing-result', () => {
  it('passes every way of keeping the answer', async () => {
    const found = await run({
      'lib/writer.ts': body(
        'export async function a(id: string, groupId: string) {',
        "  const write = await setConversationCategory(id, null, { label: 'x' });",
        '  if (!(await moveToGroupIfElsewhere(id, groupId))) return write;',
        '  const moved = (await moveToGroupIfElsewhere(id, groupId)) as boolean;',
        "  use(await setConversationCategory(id, null, { label: 'x' }));",
        '  return moved;',
        '}',
        "export const b = (id: string) => setConversationCategory(id, null, { label: 'x' });",
        // Prose about the writers is not a call.
        '// await setConversationCategory(id, null, actor);',
        "export const c = 'await moveToGroupIfElsewhere(id, group);';",
        'export const d = (id: string) => afterRoutingChanged(id, { category: true, group: false });',
      ),
      // A test sets a category it never asks about.
      'lib/writer.db.test.ts': body("await setConversationCategory(id, null, { label: 'x' });"),
    });

    expect(found).toEqual([]);
  });

  it('refuses a dropped answer, awaited or not, and names its line', async () => {
    const found = await run({
      'lib/writer.ts': body(
        'export async function a(id: string, groupId: string) {',
        "  await setConversationCategory(id, null, { label: 'x' });",
        '  void moveToGroupIfElsewhere(id, groupId);',
        '  (await moveToGroupIfElsewhere(id, groupId));',
        "  categories.setConversationCategory(id, null, { label: 'x' });",
        "  categories['setConversationCategory'](id, null, { label: 'x' });",
        "  await setConversationCategoryOn(tx, id, null, { label: 'x' });",
        '  await afterRoutingChanged(id, { category: true, group: true });',
        '}',
      ),
    });

    expect(found).toEqual([at(2), at(3), at(4), at(5), at(6), at(7)]);
    expect(found[0].message).toMatch(
      /drops setConversationCategory\(\)'s answer.*afterRoutingChanged/,
    );
  });

  // Without a group it never moves the ticket, so its answer owes nothing.
  it('holds assignConversation to it only when its options can name a group', async () => {
    const found = await run({
      'lib/writer.ts': body(
        'export async function a(id: string, groupId: string, options: AssignOptions) {',
        '  await assignConversation(id);',
        "  await assignConversation(id, { actorLabel: 'auto_assign' });",
        '  const outcome = await assignConversation(id, { groupId });',
        '  if (outcome.movedGroup) moved();',
        "  await assignConversation(id, { groupId: groupId, actorLabel: 'x' });",
        '  await assignConversation(id, { ...options });',
        '  await assignConversation(id, options);',
        "  await assignConversation(id, { ['groupId']: groupId });",
        '  await assignConversation(id, { [key]: groupId });',
        '  await afterRoutingChanged(id, { category: false, group: true });',
        '}',
      ),
    });

    expect(found).toEqual([at(6), at(7), at(8), at(9), at(10)]);
    expect(found[0].message).toMatch(/drops assignConversation\(\)'s answer/);
  });

  // The engine's shape: the move reported as it commits, so a pick that
  // throws after it cannot take the answer along (`AssignOptions.routed`).
  it('lets assignConversation answer through a routed carrier', async () => {
    const found = await run({
      'lib/writer.ts': body(
        'export async function a(id: string, groupId: string) {',
        '  const routed = { moved: false };',
        '  try {',
        '    await assignConversation(id, { groupId, routed });',
        '  } finally {',
        '    await afterRoutingChanged(id, { category: false, group: routed.moved });',
        '  }',
        '}',
      ),
    });

    expect(found).toEqual([]);
  });

  // A new caller — Jev, the router — that keeps the answer and owes nothing
  // for it; and the writers' own modules, which hand the answer on.
  it('refuses a module that calls a writer and never afterRoutingChanged', async () => {
    const found = await run({
      'lib/writer.ts': body(
        'export async function a(id: string, groupId: string) {',
        '  if (!(await moveToGroupIfElsewhere(id, groupId))) return;',
        "  const write = await setConversationCategory(id, null, { label: 'x' });",
        '  return write;',
        '}',
      ),
      'lib/assignment.ts': body(
        'export async function assignConversation(id: string, groupId: string) {',
        '  return moveToGroupIfElsewhere(id, groupId);',
        '}',
      ),
      'lib/categories.ts': body(
        'export const setConversationCategory = (id: string) =>',
        "  setConversationCategoryOn(tx, id, null, { label: 'x' });",
      ),
    });

    expect(found).toEqual([at(2)]);
    expect(found[0].message).toMatch(
      /calls moveToGroupIfElsewhere\(\) and never afterRoutingChanged\(\)/,
    );
  });

  // A write that owes nothing by design is a writer of its own, which only its
  // named module may call, and whose answer is still kept.
  it('lets only the backfill file without a follow-up, and still keeps the answer', async () => {
    const found = await run({
      'lib/category-ai/backfill.ts': body(
        'export async function a(id: string) {',
        "  const write = await fileBacklogCategory(tx, id, 'c', detail);",
        '  return write;',
        '}',
      ),
      'lib/writer.ts': body(
        'export async function b(id: string) {',
        "  const write = await fileBacklogCategory(tx, id, 'c', detail);",
        '  return write;',
        '}',
      ),
      'lib/dropped.ts': body(
        'export async function c(id: string) {',
        "  await fileBacklogCategory(tx, id, 'c', detail);",
        '}',
      ),
      // Its home exports it, and hands the answer on like any writer.
      'lib/categories/write.ts': body(
        'export async function fileBacklogCategory(tx: Tx, id: string, c: string, d: Detail) {',
        "  return setConversationCategoryOn(tx, id, c, { label: 'jev' }, d);",
        '}',
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({ rule: 'routing-result', where: 'lib/dropped.ts:2' }),
      expect.objectContaining({ rule: 'routing-result', where: 'lib/dropped.ts:2' }),
      at(2),
    ]);
    expect(found.map((each) => each.message)).toEqual([
      expect.stringMatching(/is lib\/category-ai\/backfill\.ts's alone/),
      expect.stringMatching(/drops fileBacklogCategory\(\)'s answer/),
      expect.stringMatching(/is lib\/category-ai\/backfill\.ts's alone/),
    ]);
  });

  it('no longer reads a comment as a waiver', async () => {
    const found = await run({
      'lib/writer.ts': body(
        'export async function a(id: string) {',
        '  // routing-result: no follow-up — files a backlog and fires nothing',
        "  const write = await setConversationCategoryOn(tx, id, null, { label: 'x' });",
        '  return write;',
        '}',
      ),
    });

    expect(found).toEqual([at(3)]);
    expect(found[0].message).toMatch(/never afterRoutingChanged/);
  });

  it('fails loudly when it finds too few writer calls to be checking anything', async () => {
    const found = await runRule('routing-result', {
      'lib/writer.ts': body(
        "export const a = () => setConversationCategory('x', null, { label: 'x' });",
        "export const b = () => afterRoutingChanged('x', { category: true, group: false });",
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({
        rule: 'routing-result',
        message: expect.stringMatching(/found only 1 calls of a routing writer/),
      }),
    ]);
  });
});
