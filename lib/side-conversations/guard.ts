/**
 * Who a side conversation may be addressed to.
 *
 * This module is the whole safety story of the feature, so it is pure and
 * exhaustively tested rather than woven into the action that calls it. A side
 * conversation carries what an agent knows about a customer — their address,
 * their parcel, sometimes their complaint verbatim — to a third party, and there
 * is no undo on an email.
 *
 * Three refusals, in the order they matter:
 *
 *  1. **The customer themselves.** The catastrophic one. An agent picking the
 *     wrong entry, or pasting the address out of the ticket header out of habit,
 *     sends the internal question to the person it is about. Every address we
 *     know for the requester is refused, not just the one on the ticket.
 *  2. **Ourselves.** Our own support mailbox is a loop: the reply token in the
 *     Reply-To would file our own message back onto the thread, and it would
 *     keep going.
 *  3. **Nonsense.** Empty or unparseable, refused with a sentence rather than
 *     accepted and left to fail in the worker an hour later.
 *
 * The refusals return a phrase for the agent, not a boolean, for the reason
 * already written on `readOnlyReason` in `lib/tickets/channel-policy.ts`: the
 * screen and the server action must say the same thing, or the agent reasonably
 * concludes something is broken.
 */

/**
 * Deliberately permissive. This is not an address validator — the provider is —
 * it exists to reject "Downtown Hub" and "hub-downtown" before they become a
 * failed job, and a stricter pattern would refuse legitimate addresses for no
 * gain.
 */
const ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function normaliseAddress(value: string): string {
  return value.trim().toLowerCase();
}

/** `support+s4.abc@shipblu.com` → `support@shipblu.com`. */
function stripPlus(address: string): string {
  return address.replace(/\+[^@]*(?=@)/, '');
}

export type RecipientCheck = {
  /** Lowercased addresses this system sends from. */
  ourAddresses: string[];
  /** Every address known for the ticket's requester, lowercased. */
  requesterAddresses: string[];
};

/**
 * Returns why this address may not be written to, or null if it may.
 */
export function refuseRecipient(raw: string, context: RecipientCheck): string | null {
  const address = normaliseAddress(raw);

  if (!address) return 'Choose a recipient, or type an email address';
  if (!ADDRESS.test(address)) return `"${raw.trim()}" is not an email address`;

  // Compared with the plus-suffix removed, so support+s4.sig@ is caught as
  // support@ — the address our own outbound mail actually advertises.
  const bare = stripPlus(address);

  if (context.ourAddresses.some((ours) => stripPlus(normaliseAddress(ours)) === bare)) {
    return 'That is this helpdesk’s own address. A side conversation sent there would reply to itself.';
  }

  if (context.requesterAddresses.some((theirs) => normaliseAddress(theirs) === address)) {
    return 'That is the customer’s own address. A side conversation is internal — they must never receive it.';
  }

  return null;
}

/**
 * Checks a whole recipient list, returning the first refusal.
 *
 * First rather than all of them: the composer has one error line, and an agent
 * fixing one address at a time is not worse off than one reading three
 * sentences.
 */
export function refuseRecipients(addresses: string[], context: RecipientCheck): string | null {
  for (const address of addresses) {
    const refusal = refuseRecipient(address, context);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Splits what an agent typed into a CC field.
 *
 * Commas and semicolons both, because a mail client copied from will have used
 * either, and blanks dropped so a trailing separator is not an empty recipient.
 */
export function parseAddressList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,;]/)
        .map((entry) => normaliseAddress(entry))
        .filter(Boolean),
    ),
  ];
}
