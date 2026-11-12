import type { MetaEchoSource } from '@/lib/meta/echo';

/**
 * An echo filed as the team's reply, typed somewhere other than this console:
 * on a coexistence number's phone (`ingestWhatsAppEcho`), or in Meta Business
 * Suite or another app on a Messenger thread this app holds (`ingestMetaEcho`).
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

const LABELS: Record<TeamEchoSource, string> = {
  business_app: 'WhatsApp Business app',
  meta_business_suite: 'Meta Business Suite',
  // Never seen in production (to 2026-11-12): on a thread this app holds only
  // the Page Inbox sends beside us. Named as what is known about it.
  other_app: 'Another Messenger app',
};

/** Where a team echo was typed, in the thread's words, or null for anything else. */
export function teamEchoLabel(
  meta: { echo?: unknown; echoSource?: unknown } | null,
): string | null {
  if (meta?.echo !== true || typeof meta.echoSource !== 'string') return null;
  return Object.hasOwn(LABELS, meta.echoSource) ? LABELS[meta.echoSource as TeamEchoSource] : null;
}
