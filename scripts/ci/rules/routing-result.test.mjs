import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A routing writer's answer says whether the ticket's category or group
 * changed, and so whether `afterRoutingChanged` is owed; a caller that drops it
 * cannot owe the follow-up correctly (Stage 4.0).
 */

/** Four modules keeping a writer's answer: the rule's floor. */
const KEPT = many(
  4,
  (i) => `lib/kept${i}.ts`,
  (i) =>
    `export async function f${i}(id: string) {\n  return setConversationCategory(id, null, { label: 'x' });\n}\n`,
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
        '}',
      ),
    });

    expect(found).toEqual([at(2), at(3), at(4), at(5)]);
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
        '}',
      ),
    });

    expect(found).toEqual([at(6), at(7), at(8)]);
    expect(found[0].message).toMatch(/drops assignConversation\(\)'s answer/);
  });

  it('fails loudly when it finds too few writer calls to be checking anything', async () => {
    const found = await runRule('routing-result', {
      'lib/writer.ts': body(
        "export const a = () => setConversationCategory('x', null, { label: 'x' });",
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
