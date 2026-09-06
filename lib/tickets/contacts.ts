import { and, eq, isNull, sql } from 'drizzle-orm';
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

/**
 * The contact behind an identity, without creating one.
 *
 * `resolveContact` writes a contact when it finds none, which is right for a
 * message — somebody wrote to us and there has to be a customer to file it
 * under. It is wrong for an event that can only ever attach to a thread that
 * already exists: a button press from a stranger would leave a contact row with
 * no ticket, no message and nothing to answer, one per press.
 */
export async function findContactByIdentity(
  channel: ResolveInput['channel'],
  identifier: string,
): Promise<string | null> {
  const normalised = normaliseIdentifier(channel, identifier);
  if (!normalised) return null;

  const rows = await db
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(eq(contactIdentities.channel, channel), eq(contactIdentities.identifier, normalised)),
    )
    .limit(1);

  return rows[0]?.contactId ?? null;
}

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
    return {
      contactId: existing[0].contactId,
      created: false,
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
      return { contactId: winner[0].contactId, created: false };
    }

    return { contactId, created: true };
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
 * `markFetched` is what closes the identity to further lookups, and a caller
 * that only got *part* of an answer must pass false. A customer whose profile
 * came back with a picture we then failed to download is not finished — stamping
 * them would leave them permanently faceless while Meta holds a picture for
 * them, and the backfill would skip them for the same reason. It is stamped for
 * an empty-but-successful answer, though: that is the whole point of the column,
 * since a locked-down profile answers with nothing and would otherwise be
 * re-fetched forever.
 */
export async function applyChannelProfile(input: {
  contactId: string;
  channel: ResolveInput['channel'];
  identifier: string;
  name: string | null;
  avatarPath: string | null;
  /** The channel's own locale code, e.g. Messenger's `ar_AR`. Stored verbatim. */
  profileLocale?: string | null;
  /** 'male' or 'female', already normalised. */
  gender?: string | null;
  /** False when the answer was incomplete and the identity should stay open. */
  markFetched: boolean;
}): Promise<void> {
  const identifier = normaliseIdentifier(input.channel, input.identifier);
  const name = input.name?.trim() || null;
  const profileLocale = input.profileLocale?.trim() || null;
  const gender = input.gender?.trim() || null;

  const identityPatch = {
    ...(name ? { displayName: name } : {}),
    ...(profileLocale ? { profileLocale } : {}),
    ...(input.markFetched ? { profileFetchedAt: new Date() } : {}),
  };

  await db.transaction(async (tx) => {
    /*
      Skipped when there is nothing to write, because Drizzle throws
      `No values to set` on an empty patch rather than emitting a harmless
      no-op UPDATE — and it throws *inside the transaction*, so a profile that
      answered with a picture and no name would take the avatar and gender
      writes below down with it and fail the job with a message naming neither
      the contact nor the cause. Reachable whenever a locked-down profile is
      read and the avatar download fails: no name, no locale, and `markFetched`
      false.
    */
    if (Object.keys(identityPatch).length > 0) {
      await tx
        .update(contactIdentities)
        .set(identityPatch)
        .where(
          and(
            eq(contactIdentities.channel, input.channel),
            eq(contactIdentities.identifier, identifier),
          ),
        );
    }

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

    if (gender) {
      await tx
        .update(contacts)
        .set({ gender })
        .where(and(eq(contacts.id, input.contactId), isNull(contacts.gender)));
    }
  });
}

/**
 * Whether this identity's channel profile has ever been asked for.
 *
 * Deliberately *not* folded into `resolveContact`. That function is on the hot
 * path of every inbound message on all six channels, and only the two Meta ones
 * have a profile API to ask — widening its query and its return type to carry an
 * answer the other five discard is a join that email and WhatsApp pay for
 * nothing. This is one lookup on the `(channel, identifier)` unique index, made
 * only where the question is real.
 *
 * The condition is "never asked", and only that. Gating on the name as well
 * looks safer and is not: an identity that arrived with a display name would
 * never be asked, so it would never get a picture either — and on Instagram,
 * where the handle often does arrive in the payload, that is precisely the
 * channel where a face is most useful. `profileFetchedAt` is the honest record
 * of whether the question has been put, and `applyChannelProfile` is what
 * answers it.
 */
export async function needsChannelProfile(
  channel: ResolveInput['channel'],
  identifier: string,
): Promise<boolean> {
  const rows = await db
    .select({ profileFetchedAt: contactIdentities.profileFetchedAt })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channel, channel),
        eq(contactIdentities.identifier, normaliseIdentifier(channel, identifier)),
      ),
    )
    .limit(1);

  // No row means the identity was not written — nothing to attach a profile to.
  return rows[0] !== undefined && rows[0].profileFetchedAt === null;
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
