import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * `conversations.assignee_agent_id` is written only by lib/tickets/assignee.ts,
 * which asks who may hold a ticket on its number before it writes
 * (lib/tickets/owner-only.ts). Each refusal below is a write that would not
 * have asked.
 */

const OWNER = `import { conversations } from '@/db/schema';
export async function assignTicket(tx, holders, input) {
  return tx
    .update(conversations)
    .set({ assigneeAgentId: input.to, assignedAt: input.at })
    .returning({ id: conversations.id });
}
export const ownerStamp = (ownerId, at) => ({ assigneeAgentId: ownerId, assignedAt: at });
`;

const BACKFILL = `-- files a ticket under its number
update conversations c
set channel_id = src.channel_id,
    assignee_agent_id = case when src.owner_only then null else c.assignee_agent_id end
from src
where c.id = src.conversation_id;
`;

const TREE = {
  'lib/tickets/assignee.ts': OWNER,
  'db/sql/009_whatsapp_channel_backfill.sql': BACKFILL,
  // Reading the column is everywhere, and is not a write: a select, a type, a
  // snapshot handed to a function inside an insert, a comparison in a where.
  'lib/assignment/index.ts': `import { assignTicket, ownerStamp } from '@/lib/tickets/assignee';
type Snapshot = { assigneeAgentId: string | null };
export async function pick(tx, holders, id, agentId, now) {
  const [current] = await tx
    .select({ assigneeAgentId: conversations.assigneeAgentId })
    .from(conversations)
    .where(sql\`\${conversations.assigneeAgentId} is null and c.assignee_agent_id = \${agentId}\`);
  await tx.insert(conversations).values({
    ...ownerStamp(agentId, now),
    ...routingWindowValues(plan, { assigneeAgentId: agentId }, now),
  });
  // conversations.assignee_agent_id = the agent, in a comment.
  const settings = new Map();
  settings.set('assigneeAgentId', agentId);
  const shape = { assigneeAgentId: conversations.assigneeAgentId };
  await tx.select(shape).from(conversations);
  await db.execute(sql\`select count(*) from \${conversations} c where \${conversations.assigneeAgentId} = \${agentId}\`);
  await db.execute(sql\`update \${conversations} set priority = \${p} where \${conversations.assigneeAgentId} = \${agentId}\`);
  await tx.insert(conversations).values(row).onConflictDoUpdate({ target: conversations.id, set: { subject: row.subject }, setWhere: (() => ownerStamp(agentId, now))() && undefined });
  await tx.update(conversations).set({ priority: pick(() => ownerStamp(agentId, now)) });
  return assignTicket(tx, holders, { conversationId: id, to: agentId, at: now });
}
`,
  'lib/assignment/index.db.test.ts':
    'await db.update(conversations).set({ assigneeAgentId: bob });\nawait db.execute(sql`update conversations set assignee_agent_id = null`);\n',
  'db/sql/001_triggers.sql':
    'if OLD.assignee_agent_id IS DISTINCT FROM NEW.assignee_agent_id then perform 1; end if;\nIF NEW.assignee_agent_id = OLD.assignee_agent_id THEN return NEW; END IF;\n/* assignee_agent_id = null, in a block comment */\nselect 1 from conversations c where c.assignee_agent_id = c.accountable_agent_id and "c"."assignee_agent_id" = c.id;\n',
  'db/migrations/0001_init.sql':
    'CREATE TABLE "conversations" ("id" uuid, "assignee_agent_id" uuid);\nALTER TABLE "conversations" ADD CONSTRAINT "c_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "agents"("id");\n',
};

const refusal = (where, message) =>
  expect.objectContaining({ rule: 'assignee-confinement', where, message });

describe('assignee-confinement', () => {
  it('passes the owner, the backfill, tests and every read of the column', async () => {
    expect(await runRule('assignee-confinement', TREE)).toEqual([]);
  });

  it('refuses a bare write of the assignee in a .set()', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'worker/handlers/reclaim.ts':
        'export const reclaim = (tx, id) =>\n  tx\n    .update(conversations)\n    .set({ assigneeAgentId: null, assignedAt: null })\n    .where(eq(conversations.id, id));\n',
    });

    expect(found).toEqual([
      refusal(
        'worker/handlers/reclaim.ts:4',
        expect.stringMatching(/writes conversations\.assignee_agent_id itself .* assignTicket\(\)/),
      ),
    ]);
  });

  it('refuses it as a shorthand key, and in an insert', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'app/(console)/ticket-actions.ts':
        'await tx.update(conversations).set({ assigneeAgentId, assignedAt: new Date() });\n',
      'lib/tickets/create.ts':
        'await tx.insert(conversations).values([\n  { subject, assigneeAgentId: ownerId },\n]);\n',
    });

    expect(found).toEqual([
      refusal('app/(console)/ticket-actions.ts:1', expect.any(String)),
      refusal('lib/tickets/create.ts:2', expect.any(String)),
    ]);
  });

  // How `alignAccountable` and the handover wrote it: beside another column,
  // behind a condition.
  it('refuses it in an object spread into the write, on either arm of a condition', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'lib/whatsapp/number-owner.ts': `await tx.update(conversations).set({
  ...(moves ? { accountableAgentId: ownerId } : {}),
  ...(reassign ? { assigneeAgentId: ownerId, assignedAt: now } : {}),
  ...(unassign && { assigneeAgentId: null }),
});
`,
    });

    expect(found).toEqual([
      refusal('lib/whatsapp/number-owner.ts:3', expect.any(String)),
      refusal('lib/whatsapp/number-owner.ts:4', expect.any(String)),
    ]);
  });

  it('refuses it in the set of an upsert', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'lib/import/tickets.ts':
        'await db.insert(conversations).values(row).onConflictDoUpdate({\n  target: conversations.id,\n  set: { assigneeAgentId: row.agent },\n});\n',
    });

    expect(found).toEqual([refusal('lib/import/tickets.ts:3', expect.any(String))]);
  });

  it('refuses the column assigned in raw SQL in a source file', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'worker/handlers/tidy.ts':
        'export const tidy = () =>\n  db.execute(sql`update conversations set assignee_agent_id = null where is_spam`);\n',
    });

    expect(found).toEqual([
      refusal('worker/handlers/tidy.ts:2', expect.stringMatching(/in raw SQL/)),
    ]);
  });

  it('refuses it in a db/sql file that is not named, and in a trigger', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'db/sql/013_unassign_spam.sql':
        '-- assignee_agent_id = null, in a comment\nupdate conversations\nset assignee_agent_id = null\nwhere is_spam;\n',
      'db/sql/014_trigger.sql': 'NEW.assignee_agent_id := NEW.accountable_agent_id;\n',
    });

    expect(found).toEqual([
      refusal('db/sql/013_unassign_spam.sql:3', expect.stringMatching(/SQL cannot ask who sees/)),
      refusal('db/sql/014_trigger.sql:1', expect.any(String)),
    ]);
  });

  it('follows a name handed to the builder to a const of the same file', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'worker/handlers/reclaim.ts':
        'const patch = { assigneeAgentId: null, assignedAt: null };\nexport const reclaim = (tx) => tx.update(conversations).set(patch);\nexport const again = (tx) => tx.update(conversations).set({ ...patch });\n',
    });

    expect(found).toEqual([
      refusal('worker/handlers/reclaim.ts:2', expect.any(String)),
      refusal('worker/handlers/reclaim.ts:3', expect.any(String)),
    ]);
  });

  // `ownerStamp` is for the insert that creates a ticket on an owned number.
  // In an update it is an assignment nobody asked about.
  it('refuses ownerStamp in a .set(), and passes it in an insert', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'lib/tickets/realign.ts':
        'await tx.update(conversations).set({ ...ownerStamp(ownerId, now) });\nawait tx.insert(conversations).values({ subject, ...ownerStamp(ownerId, now) });\n',
    });

    expect(found).toEqual([refusal('lib/tickets/realign.ts:1', expect.any(String))]);
  });

  it('refuses the row form, a quoted name, an insert and the column object in a set', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'worker/handlers/tidy.ts': [
        'await db.execute(sql`update conversations set (assignee_agent_id, assigned_at) = (null, null)`);',
        'await db.execute(sql`UPDATE "conversations" SET "assignee_agent_id" = NULL`);',
        'await db.execute(sql`insert into conversations (subject, assignee_agent_id) values (${a}, ${b})`);',
        'await db.execute(sql`update ${conversations} set ${conversations.assigneeAgentId} = ${b}`);',
        '',
      ].join('\n'),
    });

    expect(found.map((f) => f.where)).toEqual([
      'worker/handlers/tidy.ts:1',
      'worker/handlers/tidy.ts:2',
      'worker/handlers/tidy.ts:3',
      'worker/handlers/tidy.ts:4',
    ]);
  });

  // A custom migration is SQL written by hand, like a db/sql file.
  it('refuses the column written in a migration', async () => {
    const found = await runRule('assignee-confinement', {
      ...TREE,
      'db/migrations/0099_data_fix.sql':
        'UPDATE "conversations" SET "assignee_agent_id" = NULL WHERE "is_spam";\n',
    });

    expect(found).toEqual([refusal('db/migrations/0099_data_fix.sql:1', expect.any(String))]);
  });

  it('says so when the owner is gone, or no longer writes the column as the rule reads it', async () => {
    const { 'lib/tickets/assignee.ts': _owner, ...without } = TREE;
    expect(await runRule('assignee-confinement', without)).toEqual([
      refusal('lib/tickets/assignee.ts', expect.stringMatching(/is missing/)),
    ]);

    expect(
      await runRule('assignee-confinement', {
        ...TREE,
        'lib/tickets/assignee.ts':
          'export const assignTicket = (tx, sets) => tx.update(c).set(sets);\n',
      }),
    ).toEqual([refusal('lib/tickets/assignee.ts', expect.stringMatching(/passes by seeing none/))]);
  });

  it('refuses an exemption that has outlived its file or its write', async () => {
    const { 'db/sql/009_whatsapp_channel_backfill.sql': _backfill, ...without } = TREE;
    expect(await runRule('assignee-confinement', without)).toEqual([
      refusal('db/sql/009_whatsapp_channel_backfill.sql', expect.stringMatching(/no such file/)),
    ]);

    expect(
      await runRule('assignee-confinement', {
        ...TREE,
        'db/sql/009_whatsapp_channel_backfill.sql':
          'update conversations c set channel_id = src.channel_id from src;\n',
      }),
    ).toEqual([
      refusal('db/sql/009_whatsapp_channel_backfill.sql', expect.stringMatching(/no longer does/)),
    ]);
  });
});
