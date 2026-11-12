import type { NormalisedEcho } from './types';

/**
 * Which echoes are the team's replies typed somewhere else, and so filed on the
 * ticket as the team's reply — the way a coexistence number's phone replies are
 * (`ingestWhatsAppEcho`) — and which stay dropped.
 *
 * Pure, so the decision is a table of tests rather than a reading of the
 * handler. Measured against production on 2026-11-12, over every delivery kept
 * since 2026-10-13 (`docs/PROJECT-STATE.md` §6.117):
 *
 * - **Every Messenger echo names its app.** 37 were this app's own sends, and
 *   every one of them matched a row `send_meta` had already stored; in the 14
 *   timed, its mid was written 0.3–1.3 s before the echo reached us. The other 220 were Page
 *   Inbox's — Meta Business Suite — and none was stored anywhere: 49 in
 *   `messaging`, on threads this app held, and 171 in `standby`. No third app
 *   appeared, Freshchat included.
 * - **No Instagram echo names one** — 99 of 99 — and 15 of them are an
 *   automated welcome sent 2–5 seconds after the customer's message, which a
 *   person's reply sent from the Instagram app cannot be told from.
 *
 * So an echo is filed only when its app is named, is not this app, and sent on
 * a thread this app holds. Each refusal is a disposition of its own, so the
 * job's log line can count them apart.
 */
export type EchoDisposition =
  /** Another app's message on a thread this app holds: the team's reply. */
  | 'file'
  /** Our own send coming back. `send_meta` wrote its row when it sent it. */
  | 'own'
  /**
   * Another app held the thread, so it is that tool's until Messenger's swap
   * (`docs/PROJECT-STATE.md` §5.1), and what was asked for here is the threads
   * this app holds. Not because these are machines: all 171 stored are Page
   * Inbox's and read as typed — none within 10 s of the customer, the same
   * signed greetings — on 101 tickets, 94 never answered in the console. One
   * has arrived since the switch. Filing them is this line and a replay
   * (§6.117); a third app here would be the holder itself, automations and
   * all, and should stay out either way.
   */
  | 'standby'
  /**
   * Instagram names no app on an echo, so neither our own send nor an
   * automation can be told from a person's reply but by a race against
   * `send_meta`'s write, and the automation not at all.
   */
  | 'instagram'
  /**
   * No app to compare: the echo names none, or `META_APP_ID` is unset. Filing
   * one would file our own replies a second time.
   */
  | 'unattributed';

/**
 * Meta's Page Inbox, the inbox Meta Business Suite and the Facebook app answer
 * from. One app id for every Page, as the handover protocol documents it.
 */
export const PAGE_INBOX_APP_ID = '263902037430900';

/**
 * Where a filed echo was typed, as `messages.meta.echoSource` records it and
 * the thread labels it (`lib/tickets/thread.ts`).
 */
export type MetaEchoSource = 'meta_business_suite' | 'other_app';

export function echoDisposition(
  echo: Pick<NormalisedEcho, 'platform' | 'appId' | 'standby'>,
  ownAppId: string | null,
): EchoDisposition {
  if (echo.platform === 'instagram') return 'instagram';
  if (!ownAppId || !echo.appId) return 'unattributed';
  if (echo.appId === ownAppId) return 'own';
  if (echo.standby) return 'standby';
  return 'file';
}

/** Null never reaches it from a filed echo, which names its app; read as another. */
export function echoSourceOf(appId: string | null): MetaEchoSource {
  return appId === PAGE_INBOX_APP_ID ? 'meta_business_suite' : 'other_app';
}
