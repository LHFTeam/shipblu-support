import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { db } from '@/db/client';
import * as schema from '@/db/schema';
import {
  adminDeletions,
  attachments,
  contacts,
  conversations,
  jobs,
  messages,
  sideConversationMessages,
  sideConversations,
  ticketStatuses,
} from '@/db/schema';
import { purgeContact, purgeConversation } from './purge';

const mocks = vi.hoisted(() => ({
  database: null as typeof db | null,
  removeObjects: vi.fn(async (_paths: string[]) => ({ failed: [] as string[] })),
}));

// Every query still executes in Postgres. Only the database entry point changes:
// the purge's transaction becomes a savepoint inside a rolled-back fixture.
vi.mock('@/db/client', () => ({
  db: new Proxy(
    {},
    {
      get(_target, key) {
        if (!mocks.database) throw new Error('No purge integration fixture is active');
        const value = Reflect.get(mocks.database, key);
        return typeof value === 'function' ? value.bind(mocks.database) : value;
      },
    },
  ),
}));
vi.mock('@/lib/storage', () => ({ removeObjects: mocks.removeObjects }));

// Never use DATABASE_URL or load dotenv: only CI's explicit disposable database.
const databaseUrl = process.env.TEST_DATABASE_URL;

async function seedScope(tx: typeof db, statusId: string) {
  const contactId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const sideId = randomUUID();
  const sideMessageId = randomUUID();
  const name = `Purge integration ${contactId}`;
  const avatarPath = `contacts/${contactId}/avatar.jpg`;
  const paths = [
    `conversations/${conversationId}/message.txt`,
    `conversations/${conversationId}/side.txt`,
  ];
  await tx.insert(contacts).values({ id: contactId, name, avatarPath });
  const [conversation] = await tx
    .insert(conversations)
    .values({
      id: conversationId,
      requesterContactId: contactId,
      statusId,
      channel: 'email',
    })
    .returning({ number: conversations.number });
  await tx.insert(messages).values({
    id: messageId,
    conversationId,
    direction: 'inbound',
    authorContactId: contactId,
  });
  await tx.insert(sideConversations).values({
    id: sideId,
    conversationId,
    subject: 'Purge integration',
  });
  await tx.insert(sideConversationMessages).values({
    id: sideMessageId,
    sideConversationId: sideId,
    direction: 'outbound',
  });
  const files = await tx
    .insert(attachments)
    .values([
      {
        messageId,
        storagePath: paths[0]!,
        filename: 'message.txt',
        contentType: 'text/plain',
        sizeBytes: 1,
      },
      {
        sideMessageId,
        storagePath: paths[1]!,
        filename: 'side.txt',
        contentType: 'text/plain',
        sizeBytes: 1,
      },
    ])
    .returning({ id: attachments.id });
  return {
    contactId,
    conversationId,
    messageId,
    sideId,
    sideMessageId,
    name,
    avatarPath,
    paths,
    number: conversation!.number,
    attachmentIds: files.map((file) => file.id),
  };
}

describe.skipIf(!databaseUrl)('purge entry points against Postgres', () => {
  let client: ReturnType<typeof postgres>;
  let database: typeof db;

  beforeAll(() => {
    client = postgres(databaseUrl!, { max: 1, prepare: false });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  /** One rolled-back transaction per case; the purge runs as a savepoint in it. */
  async function fixture(run: (tx: typeof db, statusId: string) => Promise<void>) {
    const rollback = new Error('rollback purge integration fixtures');
    mocks.removeObjects.mockReset();
    mocks.removeObjects.mockImplementation(async () => ({ failed: [] }));
    try {
      await database.transaction(async (tx) => {
        mocks.database = tx;
        const statusId = randomUUID();
        await tx.insert(ticketStatuses).values({
          id: statusId,
          name: `Purge integration ${statusId}`,
          category: 'open',
        });
        await run(tx, statusId);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      mocks.database = null;
    }
  }

  async function receiptFor(tx: typeof db, subjectId: string) {
    const rows = await tx
      .select({ details: adminDeletions.details })
      .from(adminDeletions)
      .where(eq(adminDeletions.subjectId, subjectId));
    return rows[0]?.details;
  }

  it.each(['conversation', 'contact'] as const)(
    'records the %s purge storage keys before the commit and trims them to the failures after',
    async (subject) => {
      await fixture(async (tx, statusId) => {
        const target = await seedScope(tx, statusId);
        const subjectId = subject === 'contact' ? target.contactId : target.conversationId;
        const keys = [...target.paths, ...(subject === 'contact' ? [target.avatarPath] : [])];

        // Seen from inside removeObjects: the purge has committed, the rows that
        // named these keys are gone, and nothing but the audit row still knows
        // them. A worker dying here must not lose them.
        let pendingDuringRemoval: unknown;
        mocks.removeObjects.mockImplementation(async () => {
          pendingDuringRemoval = (await receiptFor(tx, subjectId))?.pendingObjects;
          return { failed: [target.paths[1]!] };
        });

        const result =
          subject === 'conversation'
            ? await purgeConversation({
                conversationId: target.conversationId,
                confirmation: String(target.number),
                agent: null,
              })
            : await purgeContact({
                contactId: target.contactId,
                confirmation: target.name,
                agent: null,
              });

        expect(result).toMatchObject({ ok: true, orphanedObjects: 1 });
        expect((pendingDuringRemoval as string[]).slice().sort()).toEqual(keys.sort());
        expect((await receiptFor(tx, subjectId))?.pendingObjects).toEqual([target.paths[1]]);
      });
    },
  );

  it("leaves a merge survivor's inherited avatar when purging the merged-away contact", async () => {
    await fixture(async (tx) => {
      // reconcileContact() copies the loser's avatar_path onto a survivor that
      // had none, so after the merge both rows name one object.
      const avatarPath = `contacts/${randomUUID()}/avatar.jpg`;
      const survivorId = randomUUID();
      const loserId = randomUUID();
      const loserName = `Purge merged loser ${loserId}`;
      await tx.insert(contacts).values({ id: survivorId, name: 'Survivor', avatarPath });
      await tx.insert(contacts).values({
        id: loserId,
        name: loserName,
        avatarPath,
        mergedIntoContactId: survivorId,
      });

      const result = await purgeContact({
        contactId: loserId,
        confirmation: loserName,
        agent: null,
      });

      expect(result).toMatchObject({ ok: true });
      expect(mocks.removeObjects.mock.calls.flatMap((call) => call[0])).not.toContain(avatarPath);
      expect(await receiptFor(tx, loserId)).not.toHaveProperty('pendingObjects');
      expect(
        await tx
          .select({ avatarPath: contacts.avatarPath })
          .from(contacts)
          .where(eq(contacts.id, survivorId)),
      ).toEqual([{ avatarPath }]);
    });
  });

  it('drops pendingObjects once every key was removed', async () => {
    await fixture(async (tx, statusId) => {
      const target = await seedScope(tx, statusId);
      await purgeConversation({
        conversationId: target.conversationId,
        confirmation: String(target.number),
        agent: null,
      });
      expect(await receiptFor(tx, target.conversationId)).not.toHaveProperty('pendingObjects');
    });
  });

  it.each(['conversation', 'contact'] as const)(
    'purges a %s with its queued work and audit receipt, preserving unrelated side emails',
    async (subject) => {
      const rollback = new Error('rollback purge integration fixtures');
      mocks.removeObjects.mockClear();
      try {
        await database.transaction(async (tx) => {
          mocks.database = tx;
          const statusId = randomUUID();
          await tx.insert(ticketStatuses).values({
            id: statusId,
            name: `Purge integration ${statusId}`,
            category: 'open',
          });
          const target = await seedScope(tx, statusId);
          const unrelated = await seedScope(tx, statusId);
          const queued = [
            { type: 'send_email', payload: { messageId: target.messageId } },
            { type: 'send_side_email', payload: { messageId: target.sideMessageId } },
            { type: 'send_csat', payload: { conversationId: target.conversationId } },
            { type: 'fetch_meta_profile', payload: { contactId: target.contactId } },
            { type: 'send_side_email', payload: { messageId: unrelated.sideMessageId } },
          ].map((job) => ({ ...job, id: randomUUID() }));
          await tx.insert(jobs).values(queued);

          const result =
            subject === 'conversation'
              ? await purgeConversation({
                  conversationId: target.conversationId,
                  confirmation: String(target.number),
                  agent: null,
                })
              : await purgeContact({
                  contactId: target.contactId,
                  confirmation: target.name,
                  agent: null,
                });
          expect(result).toMatchObject({ ok: true, orphanedObjects: 0 });

          expect(
            await tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(inArray(conversations.id, [target.conversationId, unrelated.conversationId])),
          ).toEqual([{ id: unrelated.conversationId }]);
          expect(
            await tx
              .select({ id: messages.id })
              .from(messages)
              .where(eq(messages.id, target.messageId)),
          ).toEqual([]);
          expect(
            await tx
              .select({ id: sideConversations.id })
              .from(sideConversations)
              .where(eq(sideConversations.id, target.sideId)),
          ).toEqual([]);
          expect(
            await tx
              .select({ id: sideConversationMessages.id })
              .from(sideConversationMessages)
              .where(eq(sideConversationMessages.id, target.sideMessageId)),
          ).toEqual([]);
          expect(
            await tx
              .select({ id: attachments.id })
              .from(attachments)
              .where(inArray(attachments.id, target.attachmentIds)),
          ).toEqual([]);
          const remainingContacts = await tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(inArray(contacts.id, [target.contactId, unrelated.contactId]));
          expect(remainingContacts.map((contact) => contact.id).sort()).toEqual(
            (subject === 'contact'
              ? [unrelated.contactId]
              : [target.contactId, unrelated.contactId]
            ).sort(),
          );

          const remainingJobs = await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(
              inArray(
                jobs.id,
                queued.map((job) => job.id),
              ),
            );
          expect(remainingJobs.map((job) => job.id).sort()).toEqual(
            (subject === 'contact' ? [queued[4]!.id] : [queued[3]!.id, queued[4]!.id]).sort(),
          );
          const receipt = await tx
            .select()
            .from(adminDeletions)
            .where(
              eq(
                adminDeletions.subjectId,
                subject === 'contact' ? target.contactId : target.conversationId,
              ),
            );
          expect(receipt).toHaveLength(1);
          expect(receipt[0]).toMatchObject({
            subject,
            details: {
              ticketNumbers: subject === 'contact' ? [target.number] : [],
              counts: {
                conversations: 1,
                messages: 1,
                sideConversations: 1,
                sideMessages: 1,
                attachments: 2,
              },
            },
          });
          expect(mocks.removeObjects).toHaveBeenCalledTimes(1);
          expect(mocks.removeObjects.mock.calls[0]![0].slice().sort()).toEqual(
            [...target.paths, ...(subject === 'contact' ? [target.avatarPath] : [])].sort(),
          );
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      } finally {
        mocks.database = null;
      }
    },
  );
});
