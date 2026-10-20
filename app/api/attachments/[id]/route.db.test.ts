import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  contacts,
  conversations,
  groupMembers,
  groups,
  messages,
  ticketStatuses,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * Who may download a ticket's file, against Postgres. The route puts the
 * lists' own visibility predicate (`assignmentVisibility`) into the query that
 * finds the attachment, so a group member reaches a file on a ticket waiting in
 * their group and nobody reaches one they could not open — and a file on a
 * ticket they may not see answers exactly as one that does not exist.
 *
 * The session and the signed storage URL are stood in for; the route's query,
 * joins, `COALESCE` and visibility all run as written.
 */

const session = vi.hoisted(() => ({ agent: null as SessionAgent | null }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSessionAgent: async () => session.agent,
}));
vi.mock('@/lib/storage', () => ({ signedUrl: async () => 'https://storage.example/signed' }));
const { GET } = await import('./route');

withCleanDatabase();

let member: SessionAgent;
let outsider: SessionAgent;
let admin: SessionAgent;
let careFile: string;
let merchantFile: string;

async function signedIn(role: 'admin' | 'agent', email: string): Promise<SessionAgent> {
  const [row] = await db.insert(agents).values({ name: email, email, role }).returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions: {},
    avatarUrl: null,
    avatarColor: row!.avatarColor,
    isAcceptingTickets: true,
    acceptingOffReason: null,
    sessionIdleForMs: 0,
  };
}

/** An unassigned ticket waiting in `groupId`, with one file on its message. */
async function fileInQueue(groupId: string, path: string): Promise<string> {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [ticket] = await db
    .insert(conversations)
    .values({ channel: 'whatsapp', statusId: open!.id, requesterContactId: contact!.id, groupId })
    .returning({ id: conversations.id });
  const [message] = await db
    .insert(messages)
    .values({ conversationId: ticket!.id, direction: 'inbound', bodyText: '[document: awb.pdf]' })
    .returning({ id: messages.id });
  const [file] = await db
    .insert(attachments)
    .values({
      messageId: message!.id,
      storagePath: path,
      filename: 'awb.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    })
    .returning({ id: attachments.id });
  return file!.id;
}

beforeEach(async () => {
  const [care, merchant] = await db
    .insert(groups)
    .values([{ name: 'Customer Care' }, { name: 'Merchant Care' }])
    .returning({ id: groups.id });
  member = await signedIn('agent', 'member@shipblu.test');
  outsider = await signedIn('agent', 'outsider@shipblu.test');
  admin = await signedIn('admin', 'admin@shipblu.test');
  await db.insert(groupMembers).values({ groupId: care!.id, agentId: member.id });

  careFile = await fileInQueue(care!.id, 'attachments/care');
  merchantFile = await fileInQueue(merchant!.id, 'attachments/merchant');
});

async function status(agent: SessionAgent, id: string): Promise<number> {
  session.agent = agent;
  const response = await GET(new Request(`https://support.example/api/attachments/${id}`), {
    params: Promise.resolve({ id }),
  });
  return response.status;
}

describe('GET /api/attachments/[id]', () => {
  it('hands a group member a file on a ticket waiting in their group', async () => {
    expect(await status(member, careFile)).toBe(307);
  });

  it('answers a file they may not reach exactly as a missing one', async () => {
    expect(await status(member, merchantFile)).toBe(404);
    expect(await status(outsider, careFile)).toBe(404);
  });

  it('hands an agent who sees every ticket any file', async () => {
    expect(await status(admin, merchantFile)).toBe(307);
  });
});
