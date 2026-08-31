import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, contacts, conversationEvents } from '@/db/schema';
import { normaliseSbid } from '@/lib/shipments/format';
import {
  addContactToShippingAccount,
  attachShippingAccount,
  upsertShippingAccountStub,
} from '@/lib/shipments/links';
import { identityKey, type WidgetIdentity } from './identity';

/**
 * Writing what the host page told us onto the visitor's contact.
 *
 * Read `lib/widget/identity.ts` first: everything here turns on whether the
 * claim was signed. The rules, and why each is where the line sits:
 *
 *  - **Nothing here adopts an existing contact.** The visitor's token already
 *    resolved to one, and re-pointing it at whichever contact holds the claimed
 *    email would hand a stranger that customer's chat history for the price of
 *    typing their address.
 *  - **`contacts.name` is filled only when empty**, the same rule
 *    `writeBackProfile()` follows for Meta profiles: it may be a name an agent
 *    corrected, and a page reload must not undo that.
 *  - **The email is linked with `onConflictDoNothing`**, exactly as the
 *    out-of-hours email prompt does — an address that already belongs to
 *    somebody is left with them, because merging two customers is an agent's
 *    decision.
 *  - **`contact_shipping_accounts` is written only for a verified claim.** That
 *    table says a person may speak for an account; `lib/shipments/links.ts` is
 *    explicit that only an agent or a platform sync may write it, and an
 *    unsigned claim is neither.
 *
 * The conversation-level link is different and is written either way: it says
 * the account *came up on this ticket*, which is true the moment the dashboard
 * says so, and it is what puts the account in front of the agent.
 */

/** Namespace for everything the host supplies, so it cannot shadow our own keys. */
const PREFIX = 'sb_';
const KEY_FIELD = `${PREFIX}identity_key`;
const ACCOUNT_ID_FIELD = `${PREFIX}account_id`;
const ACCOUNT_NAME_FIELD = `${PREFIX}account_name`;
const VERIFIED_FIELD = `${PREFIX}identity_verified`;

export type IdentifyOutcome =
  /** Something about the contact changed. */
  | 'applied'
  /** The same person, already recorded. */
  | 'unchanged'
  /**
   * This browser now belongs to somebody else — a second merchant signing into
   * the same dashboard on a shared machine. The caller must issue a fresh
   * visitor token rather than write, or the new person inherits the previous
   * one's conversation.
   */
  | 'reset';

export async function applyVisitorIdentity(input: {
  contactId: string;
  /** SHA-256 of the visitor token, so only that identity's label is renamed. */
  webchatIdentifier: string;
  identity: WidgetIdentity;
  verified: boolean;
}): Promise<IdentifyOutcome> {
  const { contactId, identity, verified } = input;

  const rows = await db
    .select({
      name: contacts.name,
      primaryEmail: contacts.primaryEmail,
      primaryPhone: contacts.primaryPhone,
      customFields: contacts.customFields,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const contact = rows[0];
  if (!contact) return 'reset';

  const key = identityKey(identity);
  const previous = contact.customFields[KEY_FIELD];
  if (key && typeof previous === 'string' && previous !== key) return 'reset';

  const customFields: Record<string, unknown> = { ...contact.customFields };
  for (const [field, value] of Object.entries(identity.fields)) {
    customFields[`${PREFIX}${field}`] = value;
  }
  if (key) customFields[KEY_FIELD] = key;
  if (identity.accountId) customFields[ACCOUNT_ID_FIELD] = identity.accountId;
  if (identity.accountName) customFields[ACCOUNT_NAME_FIELD] = identity.accountName;
  // Written on every apply rather than only when true: a claim that was signed
  // yesterday and is not today has stopped being a fact, and an agent reading
  // the contact should see that rather than the older, better answer.
  if (key) customFields[VERIFIED_FIELD] = verified;

  const patch: Record<string, unknown> = {};
  if (!contact.name && identity.name) patch.name = identity.name;
  if (!contact.primaryEmail && identity.email) patch.primaryEmail = identity.email;
  if (!contact.primaryPhone && identity.phone) patch.primaryPhone = identity.phone;
  if (JSON.stringify(customFields) !== JSON.stringify(contact.customFields)) {
    patch.customFields = customFields;
  }

  const changed = Object.keys(patch).length > 0;

  if (changed) {
    await db.transaction(async (tx) => {
      await tx.update(contacts).set(patch).where(eq(contacts.id, contactId));

      if (identity.name) {
        // What *this channel* calls them, which is overwritten every time —
        // scoped to the one identity the visitor's token owns, so a contact
        // that has been merged does not have its other tokens renamed too.
        await tx
          .update(contactIdentities)
          .set({ displayName: identity.name })
          .where(
            and(
              eq(contactIdentities.channel, 'webchat'),
              eq(contactIdentities.identifier, input.webchatIdentifier),
            ),
          );
      }

      if (identity.email) {
        await tx
          .insert(contactIdentities)
          .values({
            contactId,
            channel: 'email',
            identifier: identity.email,
            displayName: identity.name,
          })
          .onConflictDoNothing({
            target: [contactIdentities.channel, contactIdentities.identifier],
          });
      }
    });
  }

  /*
   * Outside the transaction: it maintains the role flags and is idempotent, and
   * a failure there must not lose the identity we just wrote.
   *
   * Only when something moved, which is also what stops an agent's decision
   * being overruled — a link they detached stays detached until the dashboard
   * says something new, rather than coming back on the visitor's next page
   * load.
   */
  const sbid = changed && verified ? claimedSbid(identity.accountId) : null;
  if (sbid) {
    await addContactToShippingAccount({
      contactId,
      shippingAccountId: await upsertShippingAccountStub(sbid),
      // The dashboard's own backend signed this, which is the platform saying
      // it — the same standing as a sync, and the reason the enum has the value.
      linkSource: 'platform',
    });
  }

  return changed ? 'applied' : 'unchanged';
}

/**
 * Puts the account the host named onto the ticket, and records what it told us.
 *
 * Called when a chat conversation is created and again whenever the identity
 * changes under a live one, because the ticket is where an agent looks — a
 * custom field on the contact is not somewhere anybody reads mid-conversation.
 */
export async function recordIdentityOnConversation(
  conversationId: string,
  contactId: string,
): Promise<void> {
  const rows = await db
    .select({ name: contacts.name, customFields: contacts.customFields })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const contact = rows[0];
  if (!contact || typeof contact.customFields[KEY_FIELD] !== 'string') return;

  const accountId = contact.customFields[ACCOUNT_ID_FIELD];
  const sbid = claimedSbid(typeof accountId === 'string' ? accountId : null);

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'contact_identified',
    actorLabel: 'webchat',
    data: {
      name: contact.name,
      accountId: typeof accountId === 'string' ? accountId : null,
      accountName: contact.customFields[ACCOUNT_NAME_FIELD] ?? null,
      // Snapshotted rather than read back from the contact later: the flag is
      // overwritten by the next identify, and the question this event answers
      // is how much the agent should have trusted the name *then*.
      verified: contact.customFields[VERIFIED_FIELD] === true,
    },
  });

  if (!sbid) return;

  const attached = await attachShippingAccount({
    conversationId,
    shippingAccountId: await upsertShippingAccountStub(sbid),
    // 'platform' even unsigned: this link means the account came up on the
    // ticket, not that the person owns it, and it came from the dashboard
    // rather than from text somebody typed.
    linkSource: 'platform',
  });

  if (attached) {
    await db.insert(conversationEvents).values({
      conversationId,
      type: 'shipping_account_linked',
      actorLabel: 'webchat',
      data: { sbid },
    });
  }
}

/**
 * The account number as a `shipping_accounts.sbid`, or null if it is not one.
 *
 * The guard matters: `accountId` is whatever the host chose to send, and
 * creating a shipping account for an id that is not an SBID fills the table
 * with rows no lookup will ever match. Three to eight digits is the capture
 * group of `DEFAULT_SBID_PATTERN` — the same definition the detector uses.
 */
function claimedSbid(accountId: string | null): string | null {
  if (!accountId) return null;
  const canonical = normaliseSbid(accountId);
  return /^\d{3,8}$/.test(canonical) ? canonical : null;
}
