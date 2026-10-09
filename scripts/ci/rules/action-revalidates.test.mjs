import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A server action's success re-renders the page only if the action marked
 * something revalidated, now that the forms do not re-read it themselves. So
 * every `ok()` an action answers comes after a revalidation on the same path.
 */

const HELPERS = {
  'lib/http/action-state.ts':
    'export type ActionState = { error: string | null; ok?: boolean };\nexport function ok() {\n  return { error: null, ok: true };\n}\n',
  'lib/tickets/console-guards.ts':
    "import { revalidatePath } from 'next/cache';\n\nexport function refresh(n: number) {\n  revalidatePath(`/inbox/${n}`);\n}\n\nexport async function requireThing() {\n  if (Math.random()) revalidatePath('/x');\n}\n",
  // lib/auth/guard.ts's shape: the redirect is on the branch that never returns.
  'lib/auth/guard.ts':
    "import { redirect } from 'next/navigation';\n\nexport async function requireAgent() {\n  const agent = await getSessionAgent();\n  if (agent) return agent;\n  redirect('/login');\n}\n",
};

/** Thirty actions that revalidate and then succeed: the rule's floor. */
const ACTIONS = many(
  30,
  (i) => `app/area${i}/actions.ts`,
  () =>
    "'use server';\n\nimport { revalidatePath } from 'next/cache';\nimport { ok } from '@/lib/http/action-state';\n\nexport async function save() {\n  revalidatePath('/x');\n  return ok();\n}\n",
);

/** An action file whose one export has `body` as its statements, from line 6. */
const action = (...body) =>
  "'use server';\n\nimport { ok } from '@/lib/http/action-state';\nimport { refresh, requireThing } from '@/lib/tickets/console-guards';\n" +
  `export async function act(state: unknown, formData: FormData) {\n${body.map((l) => `  ${l}\n`).join('')}}\n`;

/** An action file whose exports are `lines` verbatim, from line 4. */
const exportsOf = (...lines) =>
  "'use server';\n\nimport { ok } from '@/lib/http/action-state';\n" + lines.join('\n') + '\n';

const run = (files) => runRule('action-revalidates', { ...HELPERS, ...ACTIONS, ...files });

const at = (file, line, name = 'act') =>
  expect.objectContaining({
    rule: 'action-revalidates',
    where: `${file}:${line}`,
    message: expect.stringContaining(name),
  });

describe('action-revalidates', () => {
  it('passes a success after the shared refresh()', async () => {
    const found = await run({
      'app/(console)/reply-actions.ts': action('await write();', 'refresh(1);', 'return ok();'),
    });
    expect(found).toEqual([]);
  });

  it('passes a success that spreads ok() and carries a message', async () => {
    const found = await run({
      'app/(console)/meta-actions.ts': action(
        'refresh(1);',
        "return { ...ok(), message: 'Thread control taken' };",
      ),
    });
    expect(found).toEqual([]);
  });

  it('passes a revalidation in a block that encloses the return', async () => {
    const found = await run({
      'app/(console)/shipment-actions.ts': action(
        'switch (kind) {',
        "  case 'synced':",
        '    refresh(1);',
        '    return ok();',
        '}',
        "return { error: 'no' };",
      ),
    });
    expect(found).toEqual([]);
  });

  it('refuses a success with no revalidation before it', async () => {
    const found = await run({
      'app/(console)/x-actions.ts': action('await write();', 'return ok();'),
    });
    expect(found).toEqual([at('app/(console)/x-actions.ts', 7)]);
  });

  // deleteField's shape: the row is already gone, so it answers success early,
  // above the refresh() that the ordinary path reaches.
  it('refuses an early success above the revalidation', async () => {
    const found = await run({
      'app/(console)/admin/fields/actions.ts': action(
        'if (!key) return ok();',
        'await remove();',
        'refresh(1);',
        'return ok();',
      ),
    });
    expect(found).toEqual([at('app/(console)/admin/fields/actions.ts', 6)]);
  });

  it('refuses a revalidation that only one branch runs', async () => {
    const found = await run({
      'app/(console)/x-actions.ts': action('if (changed) refresh(1);', 'return ok();'),
    });
    expect(found).toEqual([at('app/(console)/x-actions.ts', 7)]);
  });

  it('refuses a ternary that can answer success', async () => {
    const found = await run({
      'app/(console)/x-actions.ts': action("return applied ? ok() : { error: 'no' };"),
    });
    expect(found).toEqual([at('app/(console)/x-actions.ts', 6)]);
  });

  it('does not count a helper that revalidates only conditionally', async () => {
    const found = await run({
      'app/(console)/x-actions.ts': action('await requireThing();', 'return ok();'),
    });
    expect(found).toEqual([at('app/(console)/x-actions.ts', 7)]);
  });

  it('counts revalidatePath imported under another name, and a local helper', async () => {
    const found = await run({
      'app/(console)/y-actions.ts':
        "'use server';\n\nimport { revalidatePath as rv } from 'next/cache';\nimport { ok } from '@/lib/http/action-state';\n\nfunction done() {\n  rv('/y');\n}\n\nexport async function a() {\n  rv('/y');\n  return ok();\n}\n\nexport async function b() {\n  done();\n  return { error: null, ok: true };\n}\n",
    });
    expect(found).toEqual([]);
  });

  // The help centre's registration answers the same thing whether or not an
  // account was made, and the page has nothing to re-read.
  it('leaves refusals and { error: null } answers alone', async () => {
    const found = await run({
      'app/help/[locale]/account/actions.ts': action(
        "if (!email) return { error: 'errorMissingFields' };",
        'return { error: null, done: true };',
      ),
    });
    expect(found).toEqual([]);
  });

  it("ignores a callback's own return, and a module without 'use server'", async () => {
    const found = await run({
      'app/(console)/z-actions.ts': action(
        'await db.transaction(async (tx) => {',
        '  return ok();',
        '});',
        'refresh(1);',
        'return ok();',
      ),
      'lib/helpers.ts':
        "import { ok } from '@/lib/http/action-state';\nexport async function helper() {\n  return ok();\n}\n",
    });
    expect(found).toEqual([]);
  });

  it('passes an action that redirects instead of answering', async () => {
    const found = await run({
      'app/(console)/inbox/new/actions.ts':
        "'use server';\n\nimport { redirect } from 'next/navigation';\n\nexport async function create() {\n  await write();\n  redirect('/inbox/1');\n}\n",
    });
    expect(found).toEqual([]);
  });

  // The console's direct-call controls read `!result.error` as success.
  it('refuses an { error: null } answer in the console that revalidated nothing', async () => {
    const found = await run({
      'app/(console)/admin/categories/actions.ts': action(
        'if (same) return { error: null };',
        'refresh(1);',
        'return { error: null };',
      ),
    });
    expect(found).toEqual([at('app/(console)/admin/categories/actions.ts', 6)]);
  });

  // requireAgent redirects only when nobody is signed in; for everyone else it
  // returns first, so it revalidates nothing on the path to the success.
  it('does not count a guard whose redirect comes after its return', async () => {
    const found = await run({
      'app/(console)/x-actions.ts':
        "'use server';\n\nimport { ok } from '@/lib/http/action-state';\nimport { requireAgent } from '@/lib/auth/guard';\nexport async function act() {\n  await requireAgent();\n  await write();\n  return ok();\n}\n",
    });
    expect(found).toEqual([at('app/(console)/x-actions.ts', 8)]);
  });

  it('sees through as, satisfies and a non-null assertion', async () => {
    const found = await run({
      'app/(console)/x-actions.ts': exportsOf(
        'export async function a() {\n  return ok() as State;\n}',
        'export async function b() {\n  return { ...ok(), message } satisfies State;\n}',
        'export async function c() {\n  return { error: null, ok: true as const };\n}',
      ),
    });
    expect(found).toEqual([
      at('app/(console)/x-actions.ts', 5, 'a'),
      at('app/(console)/x-actions.ts', 8, 'b'),
      at('app/(console)/x-actions.ts', 11, 'c'),
    ]);
  });

  // Next publishes every export of the module, whatever its syntax.
  it('reads an action written as a const, as an expression arrow, or listed in export { }', async () => {
    const found = await run({
      'app/(console)/x-actions.ts': exportsOf(
        'export const a = async () => {\n  return ok();\n};',
        'export const b = async () => ok();',
        'async function c() {\n  return ok();\n}',
        'export { c as d };',
      ),
    });
    expect(found).toEqual([
      at('app/(console)/x-actions.ts', 5, 'a'),
      at('app/(console)/x-actions.ts', 7, 'b'),
      at('app/(console)/x-actions.ts', 9, 'd'),
    ]);
  });

  it('fails loudly when it finds too few successes to have looked', async () => {
    const found = await runRule('action-revalidates', HELPERS);
    expect(found).toEqual([
      expect.objectContaining({
        rule: 'action-revalidates',
        message: expect.stringContaining('found only 0'),
      }),
    ]);
  });
});
