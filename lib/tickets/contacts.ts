import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, contactIdentities, contacts } from '@/db/schema';
import { normaliseEmail, normaliseIdentifier } from '@/lib/auth/normalise';

/**
 * Resolving an inbound message to a customer.
 *
 * `contact_identities` is the join that makes the unified inbox real: the same
 * person emailing from ali@x.com and messaging from +20100… resolves to one
 * contact, so an agent sees a single history instead of two strangers.
 */

export type ResolveInput = {
  channel: 'email' | 'whatsapp' | 'webchat' | 'facebook' | 'instagram' | 'portal' | 'api';
  identifier: string;
  displayName?: string | null;
};

export type ResolvedContact = {
  contactId: string;
  created: boolean;
};

export async function resolveContact(input: ResolveInput): Promise<ResolvedContact> {
  const identifier = normaliseIdentifier(input.channel, input.identifier);
  if (!identifier) throw new Error('Cannot resolve a contact without an identifier');

  const existing = await db
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channel, input.channel),
        eq(contactIdentities.identifier, identifier),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return { contactId: existing[0].contactId, created: false };
  }

  const isEmail = input.channel === 'email';
  const companyId = isEmail ? await findCompanyByEmailDomain(identifier) : null;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(contacts)
      .values({
        name: input.displayName ?? null,
        primaryEmail: isEmail ? identifier : null,
        primaryPhone: input.channel === 'whatsapp' ? identifier : null,
        companyId,
      })
      .returning({ id: contacts.id });

    const contactId = inserted[0]!.id;

    // Two webhooks for the same new customer can race here. The unique index on
    // (channel, identifier) is the real guard; on conflict we discard the
    // contact we just made and adopt the winner's, so one customer never ends up
    // split across two records.
    const identity = await tx
      .insert(contactIdentities)
      .values({
        contactId,
        channel: input.channel,
        identifier,
        displayName: input.displayName ?? null,
      })
      .onConflictDoNothing({
        target: [contactIdentities.channel, contactIdentities.identifier],
      })
      .returning({ id: contactIdentities.id });

    if (identity.length === 0) {
      await tx.delete(contacts).where(eq(contacts.id, contactId));

      const winner = await tx
        .select({ contactId: contactIdentities.contactId })
        .from(contactIdentities)
        .where(
          and(
            eq(contactIdentities.channel, input.channel),
            eq(contactIdentities.identifier, identifier),
          ),
        )
        .limit(1);

      if (!winner[0]) throw new Error('Contact identity conflict could not be resolved');
      return { contactId: winner[0].contactId, created: false };
    }

    return { contactId, created: true };
  });
}

/**
 * Associates a new contact with a company by email domain, so B2B customers
 * group automatically instead of an agent doing it by hand.
 */
async function findCompanyByEmailDomain(email: string): Promise<string | null> {
  const domain = normaliseEmail(email).split('@')[1];
  if (!domain) return null;

  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(sql`${domain} = ANY(${companies.domains})`)
    .limit(1);

  return rows[0]?.id ?? null;
}

/** Adds another channel identity to a known contact, e.g. after a merge. */
export async function linkIdentity(contactId: string, input: ResolveInput): Promise<void> {
  await db
    .insert(contactIdentities)
    .values({
      contactId,
      channel: input.channel,
      identifier: normaliseIdentifier(input.channel, input.identifier),
      displayName: input.displayName ?? null,
    })
    .onConflictDoNothing({ target: [contactIdentities.channel, contactIdentities.identifier] });
}
