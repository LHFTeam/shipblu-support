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
  /**
   * Nobody knows who this is yet, and no channel profile API has been asked.
   *
   * Two conditions rather than one. "Has no name" alone would re-ask on every
   * message from a customer whose profile is private and always will be, and
   * "has never been asked" alone would re-ask for somebody an agent has already
   * named by hand.
   */
  needsProfile: boolean;
};

export async function resolveContact(input: ResolveInput): Promise<ResolvedContact> {
  const identifier = normaliseIdentifier(input.channel, input.identifier);
  if (!identifier) throw new Error('Cannot resolve a contact without an identifier');

  const existing = await db
    .select({
      contactId: contactIdentities.contactId,
      name: contacts.name,
      profileFetchedAt: contactIdentities.profileFetchedAt,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(
      and(
        eq(contactIdentities.channel, input.channel),
        eq(contactIdentities.identifier, identifier),
      ),
    )
    .limit(1);

  if (existing[0]) {
    return {
      contactId: existing[0].contactId,
      created: false,
      needsProfile: !existing[0].name && existing[0].profileFetchedAt === null,
    };
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
      // The race's winner resolved the same identity a moment ago and asked for
      // the profile itself if it was needed, so this side does not repeat it.
      return { contactId: winner[0].contactId, created: false, needsProfile: false };
    }

    return { contactId, created: true, needsProfile: !input.displayName };
  });
}

/**
 * Writes back what a channel's profile API told us about a customer.
 *
 * Where the two rules differ, and why:
 *
 * - `contact_identities.display_name` is *what this channel calls them* and is
 *   overwritten every time, because that is the column's whole job. A person
 *   who renames their Instagram account should read as their new handle here.
 * - `contacts.name` is filled **only when it is empty**. It is the name an
 *   agent may have typed, or one a merge carried over from another channel, and
 *   a profile refresh must never quietly replace a human's correction with
 *   whatever Meta currently returns.
 *
 * `profileFetchedAt` is stamped whether or not a name came back — that is the
 * point of it. A customer with a locked-down profile answers successfully with
 * nothing in it, and without the timestamp they would be re-fetched forever.
 */
export async function applyChannelProfile(input: {
  contactId: string;
  channel: ResolveInput['channel'];
  identifier: string;
  name: string | null;
  avatarPath: string | null;
}): Promise<void> {
  const identifier = normaliseIdentifier(input.channel, input.identifier);
  const name = input.name?.trim() || null;

  await db.transaction(async (tx) => {
    await tx
      .update(contactIdentities)
      .set({ ...(name ? { displayName: name } : {}), profileFetchedAt: new Date() })
      .where(
        and(
          eq(contactIdentities.channel, input.channel),
          eq(contactIdentities.identifier, identifier),
        ),
      );

    // Two statements rather than one patch, because the two columns have
    // different rules and folding them together makes the stricter rule win:
    // a contact who already has a name would lose the picture as well.
    if (input.avatarPath) {
      await tx
        .update(contacts)
        .set({ avatarPath: input.avatarPath })
        .where(eq(contacts.id, input.contactId));
    }

    if (name) {
      await tx
        .update(contacts)
        .set({ name })
        .where(
          and(
            eq(contacts.id, input.contactId),
            // The empty-name rule, enforced in the WHERE rather than by reading
            // first and deciding: an agent naming the contact between the read
            // and the write would otherwise lose their edit to this job.
            sql`(${contacts.name} IS NULL OR ${contacts.name} = '')`,
          ),
        );
    }
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
