import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  ticketCategories,
  ticketForms,
} from '@/db/schema';
import { appendReply } from '@/lib/portal/tickets';
import { withCleanDatabase } from '@/lib/testing/db';
import { getFormBySlug, type LoadedForm } from './queries';
import { submitForm, type Requester } from './submit';

/**
 * The category a form opens a ticket with, through `submitForm` and a real
 * `ticket_forms` row, as the help centre and the console's New form call it.
 *
 * What only the whole path shows: who is credited — the form for its default
 * whoever submitted it, an agent only for a choice they made, because from
 * Stage 4 an agent's `category_changed` is the ground truth Jev is measured
 * against and a default is nobody's judgement — that nothing a help-centre
 * request carries can name a category, and that the form is read once, as the
 * ticket is filed, and never again.
 */

withCleanDatabase();

const SLUG = 'delivery';

/**
 * Every requester's questions on one form: `elementsFor` asks the two
 * `requester_*` questions of an anonymous visitor only, so a session and an
 * agent are asked the subject and the message and nothing else.
 */
const ELEMENTS = [
  { kind: 'system', key: 'subject' },
  { kind: 'system', key: 'description' },
  { kind: 'system', key: 'requester_name' },
  { kind: 'system', key: 'requester_email' },
];

async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  if (!row) throw new Error(`no category ${key}`);
  return row.id;
}

/** Read back through `getFormBySlug`, as both actions read the form they submit. */
async function load(): Promise<LoadedForm> {
  const loaded = await getFormBySlug(SLUG);
  if (!loaded) throw new Error(`no form ${SLUG}`);
  return loaded;
}

async function form(defaultCategoryId: string | null): Promise<LoadedForm> {
  await db
    .insert(ticketForms)
    .values({ slug: SLUG, nameEn: 'Delivery', elements: ELEMENTS, defaultCategoryId });
  return load();
}

function answers(): FormData {
  const values = new FormData();
  values.set('system.subject', 'Where is my parcel?');
  values.set('system.description', 'It has been a week.');
  values.set('system.requester_name', 'Amira');
  values.set('system.requester_email', 'amira@example.test');
  return values;
}

async function contact(): Promise<string> {
  const [row] = await db.insert(contacts).values({ name: 'Amira' }).returning({ id: contacts.id });
  return row!.id;
}

async function agent(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona', email: 'mona@shipblu.test' })
    .returning({ id: agents.id });
  return row!.id;
}

/** The help centre's two requesters, as its action builds them. */
const helpCentre = {
  session: async (): Promise<Requester> => ({ kind: 'session', contactId: await contact() }),
  anonymous: async (): Promise<Requester> => ({ kind: 'anonymous', ip: '203.0.113.7' }),
};

async function submit(
  loaded: LoadedForm,
  requester: Requester,
  values = answers(),
): Promise<{ conversationId: string; number: number }> {
  const result = await submitForm({ loaded, values, requester, locale: 'en' });
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return { conversationId: result.conversationId, number: result.number };
}

/** The category the ticket carries, and every event saying who set it. */
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

/** What a ticket filed under the form's default reads as. */
function byTheForm(id: string, key: string, label: string) {
  return {
    categoryId: id,
    events: [
      {
        actorAgentId: null,
        actorLabel: `form:${SLUG}`,
        data: { from: null, to: id, key, label },
      },
    ],
  };
}

describe('submitForm: the category a form opens a ticket with', () => {
  it.each(['session', 'anonymous'] as const)(
    'gives a help-centre %s submission the form’s default, credited to the form',
    async (kind) => {
      const sales = await categoryId('sales');
      const loaded = await form(sales);

      const { conversationId } = await submit(loaded, await helpCentre[kind]());

      expect(await categoryOf(conversationId)).toEqual(byTheForm(sales, 'sales', 'Sales'));
    },
  );

  it('credits the agent for a category they chose over the form’s default', async () => {
    const loaded = await form(await categoryId('sales'));
    const support = await categoryId('customer_support');
    const agentId = await agent();

    const { conversationId } = await submit(loaded, {
      kind: 'agent',
      contactId: await contact(),
      agentId,
      categoryId: support,
    });

    expect(await categoryOf(conversationId)).toEqual({
      categoryId: support,
      events: [
        {
          actorAgentId: agentId,
          actorLabel: null,
          data: { from: null, to: support, key: 'customer_support', label: 'Customer support' },
        },
      ],
    });
  });

  // The chooser posts its empty value unless the agent changes it, and the
  // action passes that on as `undefined`. Credited to the agent, the default
  // would count as somebody's judgement in exactly the place Stage 4 reads
  // judgements from.
  it('credits the form, not the agent, for a default the agent left alone', async () => {
    const sales = await categoryId('sales');
    const loaded = await form(sales);

    const { conversationId } = await submit(loaded, {
      kind: 'agent',
      contactId: await contact(),
      agentId: await agent(),
      categoryId: undefined,
    });

    expect(await categoryOf(conversationId)).toEqual(byTheForm(sales, 'sales', 'Sales'));
  });

  // An event with `to: null` would read "cleared the category" on a ticket that
  // never had one. The agent still opened it, and that event stays.
  it('writes neither column nor event for "no category" over a default', async () => {
    const loaded = await form(await categoryId('sales'));
    const agentId = await agent();

    const { conversationId } = await submit(loaded, {
      kind: 'agent',
      contactId: await contact(),
      agentId,
      categoryId: null,
    });

    expect(await categoryOf(conversationId)).toEqual({ categoryId: null, events: [] });
    const opened = await db
      .select({ actorAgentId: conversationEvents.actorAgentId })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversationId),
          eq(conversationEvents.type, 'opened_by_agent'),
        ),
      );
    expect(opened).toEqual([{ actorAgentId: agentId }]);
  });

  // A public form is a POST anybody can write by hand, and a category somebody
  // chose is one Jev may not change from Stage 4 — so a request that could name
  // one would let a stranger fix a ticket's routing for good. The console's
  // field name first, then every other spelling a guess might try. The
  // requester carries one too, built the way only a careless caller could: the
  // type has no room for it on these two variants, and this holds the check in
  // `submitForm` that does not rely on the type.
  it.each(['session', 'anonymous'] as const)(
    'ignores a category a help-centre %s request names',
    async (kind) => {
      const sales = await categoryId('sales');
      const loaded = await form(sales);
      const support = await categoryId('customer_support');
      const values = answers();
      for (const name of [
        'categoryId',
        'category',
        'category_id',
        'system.category',
        'system.categoryId',
        'custom.category',
      ]) {
        values.set(name, support);
      }
      const requester = { ...(await helpCentre[kind]()), categoryId: support };

      const { conversationId } = await submit(loaded, requester, values);

      expect(await categoryOf(conversationId)).toEqual(byTheForm(sales, 'sales', 'Sales'));
    },
  );

  // The priority classifier once read a form's default as it is now, and a
  // default added later claimed every ticket the form had ever filed
  // (`lib/priority-ai/run.db.test.ts`). The category is recorded at filing and
  // never read back from the form: the customer's reply runs the on-update
  // rules and assignment over the ticket, and neither gives it one.
  it('leaves a ticket filed before the form had a default alone', async () => {
    const loaded = await form(null);
    const contactId = await contact();
    const requester: Requester = { kind: 'session', contactId };
    const earlier = await submit(loaded, requester);
    expect(await categoryOf(earlier.conversationId)).toEqual({ categoryId: null, events: [] });

    const sales = await categoryId('sales');
    await db
      .update(ticketForms)
      .set({ defaultCategoryId: sales })
      .where(eq(ticketForms.slug, SLUG));
    expect(await appendReply(contactId, earlier.number, 'Any news?')).toEqual({ ok: true });

    expect(await categoryOf(earlier.conversationId)).toEqual({ categoryId: null, events: [] });
    // The edit did take: the next ticket the form files carries it.
    const later = await submit(await load(), requester);
    expect(await categoryOf(later.conversationId)).toEqual(byTheForm(sales, 'sales', 'Sales'));
  });
});
