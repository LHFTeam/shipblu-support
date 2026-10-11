import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  contacts,
  conversations,
  jobs,
  messages,
  sideConversationMessages,
  sideConversations,
  ticketStatuses,
} from '@/db/schema';
import { refuseUnlessDisposable } from '@/lib/testing/db';
import { purgeJobs } from './purge-jobs';

// Only the tier's own database, never the app's DATABASE_URL or dotenv. The
// rows are rolled back rather than truncated, but the file is refused on the
// same terms as every other `*.db.test.ts`: a `skipIf` on the variable reported
// this suite as skipped — green — in a run that had forgotten the database,
// while the files on `withCleanDatabase` beside it failed.
const databaseUrl = process.env.TEST_DATABASE_URL;

type Scope = {
  contactId: string;
  conversationId: string;
  messageId: string;
  sideId: string;
  sideMessageId: string;
};

type JobSpec = {
  label: string;
  type: string;
  payload: Record<string, unknown>;
  status?: typeof jobs.$inferInsert.status;
};

const messageJobs = [
  'send_email',
  'send_whatsapp',
  'send_meta',
  'moderate_meta_comment',
  'download_media',
  'classify_priority',
] as const;

function subjects(scope: Scope) {
  return [
    ...messageJobs.map((type) => ({ type, payload: { messageId: scope.messageId } })),
    { type: 'send_side_email', payload: { messageId: scope.sideMessageId } },
    { type: 'send_csat', payload: { conversationId: scope.conversationId } },
    { type: 'fetch_meta_profile', payload: { contactId: scope.contactId } },
  ];
}

async function seedScope(tx: typeof db, statusId: string): Promise<Scope> {
  const scope: Scope = {
    contactId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    sideId: randomUUID(),
    sideMessageId: randomUUID(),
  };
  await tx.insert(contacts).values({ id: scope.contactId, name: 'Purge queue regression' });
  await tx.insert(conversations).values({
    id: scope.conversationId,
    requesterContactId: scope.contactId,
    statusId,
    channel: 'email',
  });
  await tx.insert(messages).values({
    id: scope.messageId,
    conversationId: scope.conversationId,
    direction: 'inbound',
    authorContactId: scope.contactId,
  });
  await tx.insert(sideConversations).values({
    id: scope.sideId,
    conversationId: scope.conversationId,
    subject: 'Purge queue regression',
  });
  await tx.insert(sideConversationMessages).values({
    id: scope.sideMessageId,
    sideConversationId: scope.sideId,
    direction: 'outbound',
  });
  return scope;
}

async function seedJobs(tx: typeof db, specs: JobSpec[]) {
  const rows = specs.map(({ label, payload, ...job }) => ({
    ...job,
    id: randomUUID(),
    payload: { ...payload, regressionLabel: label },
  }));
  await tx.insert(jobs).values(rows);
  return async () => {
    const remaining = await tx
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(
        inArray(
          jobs.id,
          rows.map((row) => row.id),
        ),
      );
    return remaining.map((row) => row.payload.regressionLabel).sort();
  };
}

describe('purgeJobs against Postgres', () => {
  let client: ReturnType<typeof postgres>;
  let database: typeof db;

  beforeAll(() => {
    refuseUnlessDisposable(process.env.DATABASE_URL, databaseUrl);
    client = postgres(databaseUrl!, { max: 1, prepare: false });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  async function fixture(
    run: (tx: typeof db, target: Scope, unrelated: Scope, merged: Scope) => Promise<void>,
  ) {
    // Assertions and fixture writes share one transaction. Roll back on success
    // as well as failure so the following CI database checks still see no rows.
    const rollback = new Error('rollback purge queue fixtures');
    try {
      await database.transaction(async (tx) => {
        const statusId = randomUUID();
        await tx.insert(ticketStatuses).values({
          id: statusId,
          name: `Purge queue regression ${statusId}`,
          category: 'open',
        });
        const target = await seedScope(tx, statusId);
        const unrelated = await seedScope(tx, statusId);
        const merged = await seedScope(tx, statusId);
        await run(tx, target, unrelated, merged);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  it('removes only pending work in the supplied purge scope', async () => {
    await fixture(async (tx, target, unrelated, merged) => {
      const specs: JobSpec[] = [];
      const expected: string[] = [];
      for (const [name, scope] of [
        ['target', target],
        ['unrelated', unrelated],
        ['merged', merged],
      ] as const) {
        for (const subject of subjects(scope)) {
          // Every status the queue actually writes; `failed` is in the enum but
          // nothing sets it.
          for (const status of ['pending', 'processing', 'completed', 'dead'] as const) {
            const label = `${name}/${subject.type}/${status}`;
            specs.push({ label, status, ...subject });
            if (name === 'unrelated' || status !== 'pending') {
              expected.push(label);
            }
          }
        }
      }
      const remaining = await seedJobs(tx, specs);
      await purgeJobs(
        tx,
        [target.conversationId, merged.conversationId],
        [target.contactId, merged.contactId],
      );
      expect(await remaining()).toEqual(expected.sort());
    });
  });

  it('preserves unrelated orphans, unknown types and incidental payload keys', async () => {
    await fixture(async (tx, target, unrelated) => {
      const specs: JobSpec[] = [
        {
          label: 'unrelated side email',
          type: 'send_side_email',
          payload: { messageId: unrelated.sideMessageId },
        },
        {
          label: 'unknown type',
          type: 'future_job_type',
          payload: {
            messageId: target.messageId,
            conversationId: target.conversationId,
            contactId: target.contactId,
          },
        },
        {
          label: 'incidental conversation and contact',
          type: 'send_email',
          payload: {
            messageId: unrelated.messageId,
            conversationId: target.conversationId,
            contactId: target.contactId,
          },
        },
      ];
      for (const type of [...messageJobs, 'send_side_email', 'send_csat', 'fetch_meta_profile']) {
        for (const [name, value] of [
          ['orphan', randomUUID()],
          ['malformed', 'not-a-uuid'],
          ['null', null],
          ['number', 42],
        ] as const) {
          specs.push({
            label: `${type}/${name}`,
            type,
            payload: { messageId: value, conversationId: value, contactId: value },
          });
        }
        specs.push({ label: `${type}/missing`, type, payload: {} });
      }
      const remaining = await seedJobs(tx, specs);
      await purgeJobs(tx, [target.conversationId], [target.contactId]);
      expect(await remaining()).toEqual(specs.map((job) => job.label).sort());
    });
  });

  it('uses the job type to distinguish identical IDs in the two message tables', async () => {
    await fixture(async (tx, target, unrelated) => {
      // A UUID is unique within its table, not across the two tables. Checking
      // both tables for every messageId would delete the unrelated work here.
      await tx.insert(messages).values({
        id: unrelated.sideMessageId,
        conversationId: target.conversationId,
        direction: 'inbound',
        authorContactId: target.contactId,
      });
      await tx.insert(sideConversationMessages).values({
        id: unrelated.messageId,
        sideConversationId: target.sideId,
        direction: 'outbound',
      });
      const remaining = await seedJobs(tx, [
        {
          label: 'keep normal',
          type: 'send_email',
          payload: { messageId: unrelated.messageId },
        },
        {
          label: 'keep side',
          type: 'send_side_email',
          payload: { messageId: unrelated.sideMessageId },
        },
        {
          label: 'remove normal',
          type: 'send_email',
          payload: { messageId: unrelated.sideMessageId },
        },
        {
          label: 'remove side',
          type: 'send_side_email',
          payload: { messageId: unrelated.messageId },
        },
      ]);
      await purgeJobs(tx, [target.conversationId]);
      expect(await remaining()).toEqual(['keep normal', 'keep side']);
    });
  });

  it('keeps requester profile work when purging only their conversation', async () => {
    await fixture(async (tx, target) => {
      const specs = subjects(target).map((subject) => ({ label: subject.type, ...subject }));
      const remaining = await seedJobs(tx, specs);
      await purgeJobs(tx, [target.conversationId]);
      expect(await remaining()).toEqual(['fetch_meta_profile']);
    });
  });

  it('handles empty scopes and contacts with no conversations', async () => {
    await fixture(async (tx, target) => {
      const contactId = randomUUID();
      await tx.insert(contacts).values({ id: contactId });
      const specs: JobSpec[] = [
        ...subjects(target).map((subject) => ({ label: subject.type, ...subject })),
        {
          label: 'contact without tickets',
          type: 'fetch_meta_profile',
          payload: { contactId },
        },
      ];
      const remaining = await seedJobs(tx, specs);
      await purgeJobs(tx, []);
      expect(await remaining()).toEqual(specs.map((job) => job.label).sort());
      await purgeJobs(tx, [], [contactId]);
      expect(await remaining()).toEqual(
        subjects(target)
          .map((subject) => subject.type)
          .sort(),
      );
    });
  });
});
