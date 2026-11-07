import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  ticketCategories,
  ticketFields,
  ticketForms,
} from '@/db/schema';
import { NO_CATEGORY } from '@/lib/categories/choices';
import type { Permission } from '@/lib/auth/permissions';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * The console's New form and its category chooser, through the action an agent
 * submits, against Postgres.
 *
 * Three things only the action shows. Every refusal — of the chooser's value,
 * and the form's own over an answer, a file or the address — comes before the
 * requester is resolved, because resolving inserts a contact and its identity
 * for an address nobody has written from: a refusal after it would leave a
 * customer record behind for a ticket never opened, one more for each address
 * the agent tried. A ticket that opens still joins the contact that owns the
 * address. And the chooser's three kinds of value reach the ticket credited to
 * the right actor: a pick to the agent, an untouched chooser to the form, "No
 * category" to nobody.
 */

const signedIn = vi.hoisted(() => ({
  id: '',
  permissions: {} as Record<string, boolean>,
}));

// The real permission decision, against the overrides a test sets: the action
// asks `can()` itself about `ticket.set_category` on the agent this returns.
vi.mock('@/lib/auth/guard', async () => {
  const { can } =
    await vi.importActual<typeof import('@/lib/auth/permissions')>('@/lib/auth/permissions');
  return {
    requirePermission: async (permission: Permission) => {
      const agent = {
        id: signedIn.id,
        name: 'Mona Agent',
        role: 'agent' as const,
        permissions: signedIn.permissions,
      };
      if (!can(agent, permission)) throw new Error(`NEXT_REDIRECT forbidden: ${permission}`);
      return agent;
    },
  };
});
// Next's redirect is a throw; this one carries the path, so a success can be
// told from a refusal and followed to the ticket it opened.
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const { createTicketFromForm } = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };
const SLUG = 'delivery';
const NEW_ADDRESS = 'nadia@example.test';
const NOBODY = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

beforeEach(async () => {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Mona Agent', email: 'mona@shipblu.test', role: 'agent' })
    .returning({ id: agents.id });
  signedIn.id = agent!.id;
  signedIn.permissions = {};
});

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  if (!row) throw new Error(`no category ${key}`);
  return row.id;
}

async function retire(key: string): Promise<string> {
  const id = await categoryId(key);
  await db.update(ticketCategories).set({ isActive: false }).where(eq(ticketCategories.id, id));
  return id;
}

/** A console form asking an agent the subject and the message, nothing else. */
async function form(defaultCategoryId: string | null = null) {
  await db.insert(ticketForms).values({
    slug: SLUG,
    nameEn: 'Delivery',
    elements: [
      { kind: 'system', key: 'subject' },
      { kind: 'system', key: 'description' },
    ],
    defaultCategoryId,
  });
}

/** Everything the page posts, for a customer the helpdesk has never heard from. */
function submission(categoryId: string): FormData {
  const data = new FormData();
  data.set('slug', SLUG);
  data.set('requesterEmail', NEW_ADDRESS);
  data.set('requesterName', 'Nadia');
  data.set('categoryId', categoryId);
  data.set('system.subject', 'Where is my parcel?');
  data.set('system.description', 'She phoned: it has been a week.');
  return data;
}

/**
 * A console form asking everything a submission can be refused over besides
 * the address: a required field, a field with rules of its own, and files.
 */
async function formWithQuestions() {
  await db.insert(ticketFields).values([
    { key: 'order_number', label: 'Order number', type: 'text', requiredOnCreate: true },
    { key: 'weight', label: 'Weight', type: 'number' },
  ]);
  await db.insert(ticketForms).values({
    slug: SLUG,
    nameEn: 'Delivery',
    elements: [
      { kind: 'system', key: 'subject' },
      { kind: 'system', key: 'description' },
      { kind: 'field', key: 'order_number' },
      { kind: 'field', key: 'weight' },
      { kind: 'system', key: 'attachments' },
    ],
  });
}

/** `submission`, with every question `formWithQuestions` asks answered. */
function answered(): FormData {
  const data = submission('');
  data.set('custom.order_number', 'SB-10422');
  data.set('custom.weight', '2');
  return data;
}

/**
 * Whether anything at all was written: a contact, an identity, a ticket. Every
 * row, not only the address's, so nothing filed under another spelling of it,
 * or under an address that is not one, is missed.
 */
async function traces() {
  return {
    contacts: await db.select({ id: contacts.id }).from(contacts),
    identities: await db.select({ id: contactIdentities.id }).from(contactIdentities),
    tickets: await db.select({ id: conversations.id }).from(conversations),
  };
}

/** The contact a ticket is filed under, and every `unverified_submitter` on it. */
async function requesterOf(conversationId: string) {
  const [row] = await db
    .select({ contactId: conversations.requesterContactId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  const unverified = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'unverified_submitter'),
      ),
    );
  return { contactId: row!.contactId, unverified };
}

/** Submits, expecting the redirect to the new ticket, and answers with the ticket's id. */
async function opened(data: FormData): Promise<string> {
  const outcome = await createTicketFromForm(INITIAL, data).then(
    (state) => ({ state }),
    (error: unknown) => ({ error }),
  );
  if (!('error' in outcome)) throw new Error(`refused: ${JSON.stringify(outcome.state)}`);

  const redirect = /^NEXT_REDIRECT \/inbox\/(\d+)$/.exec(String((outcome.error as Error).message));
  if (!redirect) throw outcome.error;
  const [ticket] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.number, Number(redirect[1])));
  return ticket!.id;
}

/** The ticket's category, and every `category_changed` saying who set it. */
async function categoryOf(conversationId: string) {
  const [row] = await db
    .select({ categoryId: conversations.categoryId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  const events = await db
    .select({
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'category_changed'),
      ),
    );
  return { categoryId: row!.categoryId, events };
}

describe('createTicketFromForm refusing the chooser', () => {
  it.each([
    ['a malformed id', () => 'not-a-uuid', {}, 'Unknown category'],
    ['an id naming no category', () => NOBODY, {}, 'Unknown category'],
    [
      'a retired category',
      () => retire('sales'),
      {},
      'That category has been retired — choose another',
    ],
    [
      'any category from an agent who may not set one',
      () => categoryId('sales'),
      { 'ticket.set_category': false },
      "You cannot set a ticket's category",
    ],
    [
      'none from an agent who may not set one',
      () => NO_CATEGORY,
      { 'ticket.set_category': false },
      "You cannot set a ticket's category",
    ],
  ])(
    'refuses %s with a sentence, before writing a contact for the address',
    async (_name, value, permissions, error) => {
      await form(await categoryId('customer_support'));
      const chosen = await value();
      signedIn.permissions = permissions;

      await expect(createTicketFromForm(INITIAL, submission(chosen))).resolves.toEqual({ error });

      expect(await traces()).toEqual({ contacts: [], identities: [], tickets: [] });
    },
  );
});

describe('createTicketFromForm refusing the form’s answers', () => {
  // `submitForm`'s own refusals — `missing`, `invalid`, `files` — and the
  // address, which the action refuses first and `submitForm` again. Before the
  // contact was resolved inside `submitForm`, each of the first three left a
  // contact and its identity behind, one per address an agent tried.
  it.each<[string, (data: FormData) => void, string]>([
    [
      'a required question left blank',
      (data) => data.delete('custom.order_number'),
      'Fill in Order number',
    ],
    [
      'an answer the field’s own rules refuse',
      (data) => data.set('custom.weight', 'heavy'),
      'Check Weight',
    ],
    [
      'a file the form will not take',
      (data) =>
        data.append(
          'attachments',
          new File(['MZ'], 'label.exe', { type: 'application/x-msdownload' }),
        ),
      'That attachment could not be accepted',
    ],
    [
      'an address that is not one',
      (data) => data.set('requesterEmail', 'nadia'),
      'Enter the customer’s email address',
    ],
  ])(
    'refuses %s with a sentence, before writing a contact for the address',
    async (_name, change, error) => {
      await formWithQuestions();
      const data = answered();
      change(data);

      await expect(createTicketFromForm(INITIAL, data)).resolves.toEqual({ error });

      expect(await traces()).toEqual({ contacts: [], identities: [], tickets: [] });
    },
  );

  // The cases' control: the answers they each change once open a ticket as
  // they stand, so each refusal above is the one thing its case changed.
  it('opens the ticket from the same answers, under a new contact for a new address', async () => {
    await formWithQuestions();

    const ticket = await opened(answered());

    const created = await db
      .select({ id: contacts.id, name: contacts.name, primaryEmail: contacts.primaryEmail })
      .from(contacts);
    expect(created).toEqual([{ id: expect.any(String), name: 'Nadia', primaryEmail: NEW_ADDRESS }]);
    expect(
      await db
        .select({
          contactId: contactIdentities.contactId,
          channel: contactIdentities.channel,
          identifier: contactIdentities.identifier,
        })
        .from(contactIdentities),
    ).toEqual([{ contactId: created[0]!.id, channel: 'email', identifier: NEW_ADDRESS }]);
    expect(await requesterOf(ticket)).toEqual({ contactId: created[0]!.id, unverified: [] });
  });
});

describe('createTicketFromForm filing the requester', () => {
  // Resolved the way an inbound email is, so a ticket opened for a customer on
  // the phone joins their history rather than starting a second stranger with
  // the same address. The name the agent typed is only for a contact created
  // here: `resolveContact` never renames one that exists. And an agent typing
  // the address of somebody they are speaking to is not a stranger's claim, so
  // there is no `unverified_submitter`.
  it('joins the contact that owns the address, as typed in any case, and keeps its name', async () => {
    await form();
    const [existing] = await db
      .insert(contacts)
      .values({ name: 'Nadia Hassan', primaryEmail: NEW_ADDRESS })
      .returning({ id: contacts.id });
    await db
      .insert(contactIdentities)
      .values({ contactId: existing!.id, channel: 'email', identifier: NEW_ADDRESS });
    const data = submission('');
    data.set('requesterEmail', '  Nadia@Example.TEST ');
    data.set('requesterName', 'N. Hassan');

    const ticket = await opened(data);

    expect(await requesterOf(ticket)).toEqual({ contactId: existing!.id, unverified: [] });
    expect(await db.select({ id: contacts.id, name: contacts.name }).from(contacts)).toEqual([
      { id: existing!.id, name: 'Nadia Hassan' },
    ]);
    expect(
      await db.select({ contactId: contactIdentities.contactId }).from(contactIdentities),
    ).toEqual([{ contactId: existing!.id }]);
  });
});

describe('createTicketFromForm filing the chooser’s answer', () => {
  it('files a category the agent picked as the agent’s, over the form’s default', async () => {
    await form(await categoryId('customer_support'));
    const sales = await categoryId('sales');

    const ticket = await opened(submission(sales));

    expect(await categoryOf(ticket)).toEqual({
      categoryId: sales,
      events: [
        {
          actorAgentId: signedIn.id,
          actorLabel: null,
          data: { from: null, to: sales, key: 'sales', label: 'Sales' },
        },
      ],
    });
  });

  // Run without the permission: it gates a choice, not the form's own default,
  // which an agent who was never shown the chooser still files under.
  it('files an untouched chooser under the form’s default, credited to the form', async () => {
    const support = await categoryId('customer_support');
    await form(support);
    signedIn.permissions = { 'ticket.set_category': false };

    const ticket = await opened(submission(''));

    const [category] = await db
      .select({ labelEn: ticketCategories.labelEn })
      .from(ticketCategories)
      .where(eq(ticketCategories.id, support));
    expect(await categoryOf(ticket)).toEqual({
      categoryId: support,
      events: [
        {
          actorAgentId: null,
          actorLabel: `form:${SLUG}`,
          data: { from: null, to: support, key: 'customer_support', label: category!.labelEn },
        },
      ],
    });
  });

  // An event with `to: null` would read "cleared the category" on a ticket that
  // never had one.
  it('files "No category" over a default as no category and no event', async () => {
    await form(await categoryId('customer_support'));

    const ticket = await opened(submission(NO_CATEGORY));

    expect(await categoryOf(ticket)).toEqual({ categoryId: null, events: [] });
  });
});
