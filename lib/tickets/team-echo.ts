import type { MetaEchoSource } from '@/lib/meta/echo';

/**
 * An echo filed as the team's reply, typed somewhere other than this console:
 * on a coexistence number's phone (`ingestWhatsAppEcho`), or on Messenger in
 * Meta Business Suite, or in another app on a thread this app holds
 * (`ingestMetaEcho`).
 * `messages.meta.echoSource` says which.
 *
 * An echo with no source is the customer bot's half of its transcript, written
 * by a machine — its rows predate the field — so it is not one of these.
 *
 * Client-safe, for the thread; one answer for every reader that asks whether a
 * person on the team answered, so the timeline and what Jev is told cannot
 * disagree about the same row.
 */
export type TeamEchoSource = 'business_app' | MetaEchoSource;

/**
 * Who the thread names as its author, and the chip beside it saying the reply
 * was sent from outside this console — so a reply typed in Business Suite reads
 * at a glance as the team's, and as not written here, beside an agent's own.
 */
const LABELS: Record<TeamEchoSource, { author: string; chip: string }> = {
  business_app: { author: 'WhatsApp Business app', chip: 'Sent from the phone' },
  meta_business_suite: { author: 'Meta Business Suite', chip: 'Sent from Business Suite' },
  // Never seen in production (to 2026-11-12): on a thread this app holds only
  // the Page Inbox sends beside us. Named as what is known about it.
  other_app: { author: 'Another Messenger app', chip: 'Sent from another app' },
};

function sourceOf(meta: { echo?: unknown; echoSource?: unknown } | null): TeamEchoSource | null {
  if (meta?.echo !== true || typeof meta.echoSource !== 'string') return null;
  return Object.hasOwn(LABELS, meta.echoSource) ? (meta.echoSource as TeamEchoSource) : null;
}

/** Where a team echo was typed, in the thread's words, or null for anything else. */
export function teamEchoLabel(
  meta: { echo?: unknown; echoSource?: unknown } | null,
): string | null {
  const source = sourceOf(meta);
  return source ? LABELS[source].author : null;
}

/** The chip a team echo carries in the thread, or null for anything else. */
export function teamEchoChip(meta: { echo?: unknown; echoSource?: unknown } | null): string | null {
  const source = sourceOf(meta);
  return source ? LABELS[source].chip : null;
}
