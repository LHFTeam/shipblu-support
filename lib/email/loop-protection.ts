import type { ParsedInboundEmail } from './types';

/**
 * Detecting mail we must not auto-reply to.
 *
 * The failure this prevents is a mail loop: our autoresponder answers an
 * out-of-office, which answers back, which we answer again — thousands of
 * messages and a blown sending reputation within hours. RFC 3834 exists for
 * exactly this, and honouring it is not optional.
 *
 * Note the asymmetry: an automated message can still be worth *filing* (a
 * bounce tells an agent the customer never got the reply), so this returns a
 * classification rather than a simple drop/keep, and only the auto-reply
 * decision is hard-blocked.
 */

export type AutomationVerdict = {
  /** Machine-generated: autoresponder, mailing list, notification. */
  isAutomated: boolean;
  /** A delivery failure report. */
  isBounce: boolean;
  /**
   * An autoresponder answering a person — out of office, "we got your mail" —
   * on a signal that exists for nothing else. Narrower than `isAutomated` on
   * purpose; see `isAutoReplyHeader`.
   */
  isAutoReply: boolean;
  /** False whenever isAutomated or isBounce is true. Never override this. */
  shouldAutoReply: boolean;
  /** Which signal fired, recorded on the message for diagnosis. */
  reason: string | null;
};

const AUTOMATED_LOCAL_PARTS = [
  'mailer-daemon',
  'postmaster',
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'bounce',
  'bounces',
  'notifications',
  'notification',
];

/**
 * The headers that say "an autoresponder wrote this", and nothing broader.
 *
 * `isAutomated` answers "must we not auto-reply?", where a wrong yes costs
 * nothing, so it also takes mailing lists, `X-Auto-Response-Suppress` (a
 * request not to be answered, not a statement of who wrote the mail) and
 * guesses from a `no-reply@` sender. Ingest uses `isAutoReply` to keep a
 * message from reopening a ticket or joining the working queue, where a wrong
 * yes hides a real customer — so it takes only the RFC 3834 value for an
 * autoresponder and the two vendor headers that mean the same. An
 * autoresponder that sets none of them is missed, and lands as it did before.
 */
function isAutoReplyHeader(email: ParsedInboundEmail): boolean {
  return (
    header(email, 'auto-submitted')?.trim().toLowerCase() === 'auto-replied' ||
    // Truthy, not merely present: the chain below reads these the same way, so
    // an empty `X-Autoreply:` is neither automated nor an auto-reply.
    Boolean(header(email, 'x-autoreply')) ||
    Boolean(header(email, 'x-autorespond')) ||
    header(email, 'precedence')?.trim().toLowerCase() === 'auto_reply'
  );
}

/** Precedence values that mark bulk or automated mail. */
const BULK_PRECEDENCE = ['bulk', 'junk', 'list', 'auto_reply'];

function header(email: ParsedInboundEmail, name: string): string | undefined {
  return email.headers[name.toLowerCase()];
}

export function classifyAutomation(email: ParsedInboundEmail): AutomationVerdict {
  // Read apart from the chain below, which stops at the first signal: an
  // `Auto-Submitted: auto-generated` with `X-Autoreply` beside it is still an
  // autoresponder. A bounce is never one — it is kept as the failure it
  // reports, which is the one automated mail an agent needs to see. And an
  // auto-reply is always automated: ingest skips the reopen for one, and the
  // acknowledgement code assumes it never runs on a resolved ticket, so an
  // auto-reply that still allowed `shouldAutoReply` would answer a finished one.
  const autoReply = isAutoReplyHeader(email);

  const verdict = (
    reason: string | null,
    flags: { automated?: boolean; bounce?: boolean } = {},
  ): AutomationVerdict => {
    const isAutomated = flags.automated ?? false;
    const isBounce = flags.bounce ?? false;
    return {
      isAutomated,
      isBounce,
      isAutoReply: autoReply && isAutomated && !isBounce,
      shouldAutoReply: !isAutomated && !isBounce,
      reason,
    };
  };

  // --- Bounces first: they are the most actionable classification ---------

  // A null return-path is the canonical marker of a delivery status notification.
  const returnPath = header(email, 'return-path');
  if (returnPath !== undefined && returnPath.replace(/\s/g, '') === '<>') {
    return verdict('null_return_path', { bounce: true, automated: true });
  }

  const contentType = header(email, 'content-type') ?? '';
  if (/multipart\/report/i.test(contentType) && /delivery-status/i.test(contentType)) {
    return verdict('delivery_status_report', { bounce: true, automated: true });
  }

  const fromLocal = email.from.address.split('@')[0]?.toLowerCase() ?? '';
  if (fromLocal === 'mailer-daemon' || fromLocal === 'postmaster') {
    return verdict('daemon_sender', { bounce: true, automated: true });
  }

  // --- RFC 3834 -----------------------------------------------------------

  // "no" is the one value that explicitly means "this is a human message".
  const autoSubmitted = header(email, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') {
    return verdict(`auto_submitted:${autoSubmitted.trim().toLowerCase()}`, { automated: true });
  }

  // --- Vendor-specific autoresponder markers ------------------------------

  for (const name of ['x-autoreply', 'x-autorespond', 'x-auto-response-suppress']) {
    if (header(email, name)) return verdict(name, { automated: true });
  }

  const precedence = header(email, 'precedence')?.trim().toLowerCase();
  if (precedence && BULK_PRECEDENCE.includes(precedence)) {
    return verdict(`precedence:${precedence}`, { automated: true });
  }

  // --- Mailing lists ------------------------------------------------------

  if (header(email, 'list-id') || header(email, 'list-unsubscribe')) {
    return verdict('mailing_list', { automated: true });
  }

  // --- Sender heuristics --------------------------------------------------
  //
  // Checked last: these are guesses, unlike the header signals above. A human
  // can sit behind notifications@, so this suppresses auto-reply without
  // claiming the message is a bounce.
  if (AUTOMATED_LOCAL_PARTS.includes(fromLocal)) {
    return verdict(`sender_local_part:${fromLocal}`, { automated: true });
  }

  return verdict(null);
}

/**
 * Guards against our own address appearing as the sender. Without this, a
 * misconfigured forwarding rule can make the helpdesk converse with itself.
 */
export function isSelfAddressed(email: ParsedInboundEmail, ourAddresses: string[]): boolean {
  const from = email.from.address.toLowerCase();
  return ourAddresses.some((addr) => {
    const ours = addr.toLowerCase();
    // Compare ignoring any plus-suffix, so support+c12.sig@ matches support@.
    const strip = (a: string) => a.replace(/\+[^@]*(?=@)/, '');
    return strip(from) === strip(ours);
  });
}
