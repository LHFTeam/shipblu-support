/**
 * What a purge would destroy, in words — and nothing that touches a database.
 *
 * Split out of `purge.ts` for one reason, and it is a build-time reason rather
 * than a tidiness one: the confirmation panel is a client component, and it
 * needs the confirmation check and the count wording. Importing those from
 * `purge.ts` pulls `db/client` — and through it the `postgres` driver — into the
 * browser bundle, which fails `next build` with a module-not-found on
 * `node:crypto` and friends while `tsc`, `eslint` and `vitest` all stay green.
 * The same shape of trap AGENTS.md records for React's export conditions: only
 * the production build sees it.
 *
 * So the rule is: anything the panel imports lives here, and here imports
 * nothing.
 */

/**
 * What a purge knowingly leaves behind.
 *
 * `webhook_events` is the raw provider envelope exactly as it arrived, and it is
 * keyed by the provider's ids — a WhatsApp `wamid`, a Meta entry id — with no
 * reference to our contact or conversation at all. Finding a customer's rows in
 * it would mean pattern-matching phone numbers and scoped ids across a JSON
 * archive of 130k+ payloads, and getting that wrong in either direction is worse
 * than not doing it: too eager destroys the replay evidence for unrelated
 * traffic, too timid gives a false assurance.
 *
 * So the archive is retained, and the console says so rather than promising an
 * erasure it does not perform. If this ever needs to be a real
 * right-to-be-forgotten, it is a separate job that works from identifiers, not a
 * clause bolted onto this one.
 *
 * The nightly rollup is the other one. `metrics_daily` and `agent_metrics_daily`
 * are rebuilt from `conversations` for the last three days, so a purge inside
 * that window corrects itself and one outside it does not — the older day keeps
 * counting a ticket that no longer exists. `agent_backlog_snapshots` is worse
 * and deliberately so: it is sampled hourly precisely because it cannot be
 * recomputed, so nothing can retro-correct it. Both are aggregates over a
 * archive that is being actively measured, and silently rewriting history to
 * match a deletion would be its own kind of lie.
 *
 * The rest are the places the customer's own words and details survive, listed
 * because the first version of this list named only the two above and so read
 * as a promise that everything else went:
 *
 * - **Finished queue jobs.** Only pending and failed jobs owned by the purge are
 *   removed. A completed or dead `send_email`/`send_meta` row keeps the payload
 *   it was enqueued with — an address, sometimes a body — and a job a worker is
 *   holding is left to finish rather than yanked out from under it.
 * - **What they wrote on somebody else's ticket.** `messages.author_contact_id`
 *   is `set null`, so a reply they sent into another customer's thread — a CC'd
 *   email, a merged conversation — stays in that thread with no author.
 * - **The deletion record itself.** `admin_deletions.summary` names the customer
 *   and their address or number, or the ticket and its subject, because that is
 *   the only way "where did #482 go" can be answered afterwards. It is why this
 *   is a cleanup tool and not an erasure.
 * - **Deliveries already in the queue.** A webhook that arrived before the purge
 *   and is still waiting to be ingested will, when it runs, find no contact for
 *   its sender and create one — the customer can reappear minutes later.
 *
 * Each entry is a clause of one sentence the panel reads out, so they stay short
 * and agent-facing; the reasoning lives here.
 */
export const RETAINED = [
  'the raw webhook archive, which is keyed by provider ids and not by ours',
  'already-rolled-up daily metrics, which cannot be recomputed for past days',
  'finished and running queue jobs, whose payloads can hold the customer’s address and message text',
  'messages they wrote on other customers’ tickets, kept there without an author',
  'the deletion record, which keeps their name and contact details or the ticket’s subject — so this is not a data-erasure tool',
  'incoming messages already queued when you delete, which can create the customer again',
] as const;

export type PurgeRefusal = 'not_found' | 'confirmation_mismatch';

/** Row counts a purge destroyed, per table an admin would recognise. */
export type PurgeCounts = {
  conversations: number;
  messages: number;
  attachments: number;
  events: number;
  sideConversations: number;
  sideMessages: number;
  csatSurveys: number;
  /** Contact purges only; zero on a conversation purge. */
  identities: number;
  tombstones: number;
  shippingAccountLinks: number;
  /** Parcels that survived with their party unset, rather than being deleted. */
  shipmentsDetached: number;
};

export const NO_COUNTS: PurgeCounts = {
  conversations: 0,
  messages: 0,
  attachments: 0,
  events: 0,
  sideConversations: 0,
  sideMessages: 0,
  csatSurveys: 0,
  identities: 0,
  tombstones: 0,
  shippingAccountLinks: 0,
  shipmentsDetached: 0,
};

export type PurgePreview = {
  id: string;
  /** The line the confirmation dialog leads with. */
  summary: string;
  /**
   * What the admin has to type back. Never derived on the client: the action
   * re-reads the row and re-derives this, so a tampered form field is checked
   * against the database rather than against itself.
   */
  confirmation: string;
  counts: PurgeCounts;
  /** Ticket numbers a contact purge would take with it. Empty for a ticket. */
  ticketNumbers: number[];
};

export type PurgeResult =
  | { ok: true; summary: string; counts: PurgeCounts; orphanedObjects: number }
  | { ok: false; reason: PurgeRefusal };

/**
 * Matching what somebody typed against what they were shown.
 *
 * Trimmed and case-folded because the confirmation is a speed bump against the
 * wrong click, not a password — an admin who reads "482" and types " 482" has
 * demonstrated everything this check is asking for.
 */
export function confirmationMatches(expected: string, typed: string): boolean {
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const wanted = normalise(expected);
  return wanted !== '' && normalise(typed) === wanted;
}

/**
 * The word an admin types to prove they mean this contact.
 *
 * An address or a number rather than a name wherever there is one, because those
 * are unique and a name is not — "Ahmed" is on the screen several times a week.
 * The id's first segment is the last resort, and it is the honest one: a contact
 * with no name, no email and no phone is exactly the junk record this feature
 * exists to remove, and there is nothing else true to ask for.
 */
export function contactConfirmation(contact: {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
}): string {
  const candidate = [contact.primaryEmail, contact.primaryPhone, contact.name].find(
    (value) => value !== null && value.trim() !== '',
  );
  return candidate?.trim() ?? contact.id.split('-')[0]!;
}

/** How a contact is named in the audit trail, once the row is gone. */
export function contactLabel(contact: {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
}): string {
  const name = contact.name?.trim();
  const handle = [contact.primaryEmail, contact.primaryPhone]
    .filter((value) => value !== null && value.trim() !== '')
    .join(' · ');

  if (name && handle) return `${name} (${handle})`;
  if (name) return name;
  if (handle) return handle;
  return `Unnamed contact ${contact.id.split('-')[0]}`;
}

/**
 * The blast radius as a list of phrases, for the confirmation panel.
 *
 * Zeroes are dropped rather than rendered as "0 attachments": a list of what
 * will actually go is read, and a list padded with nothing is skimmed.
 *
 * `shipmentsDetached` is deliberately absent. Everything here is destroyed, and
 * a parcel is not — it survives with its shipper or recipient unset — so putting
 * it in the same list would be the one misleading line on a screen whose whole
 * job is to be believed. The panel states it separately.
 */
export function describePurgeCounts(counts: PurgeCounts): string[] {
  const parts: [number, string, string][] = [
    [counts.conversations, 'ticket', 'tickets'],
    [counts.messages, 'message', 'messages'],
    [counts.attachments, 'attachment', 'attachments'],
    [counts.sideConversations, 'side conversation', 'side conversations'],
    [counts.sideMessages, 'side-conversation message', 'side-conversation messages'],
    [counts.events, 'timeline entry', 'timeline entries'],
    [counts.csatSurveys, 'CSAT response', 'CSAT responses'],
    [counts.identities, 'address or number', 'addresses and numbers'],
    [counts.tombstones, 'merged-away record', 'merged-away records'],
    [counts.shippingAccountLinks, 'account membership', 'account memberships'],
  ];

  return parts
    .filter(([n]) => n > 0)
    .map(([n, singular, plural]) => `${n} ${n === 1 ? singular : plural}`);
}
