/**
 * Turning Meta's delivery errors into something an agent can act on.
 *
 * Meta's wording describes the rule it enforced, not the mistake that was made,
 * and for one code in particular the two are badly mismatched: 131047 reads
 * "more than 24 hours have passed since the customer last replied to this
 * number" even when the customer wrote a minute ago — because the message went
 * out from a *different* business number than the one they wrote to. Left
 * as-is, an agent reads that and reports a bug in the countdown.
 */

/** Sending from a business number the customer has no open window with. */
export const RE_ENGAGEMENT_CODE = 131047;

/**
 * An access token that has expired or been revoked.
 *
 * Meta reports the fact — "Session has expired on Tuesday, 18-Aug-26" — and not
 * the cause, which is almost always that the token in the environment is a
 * short-lived user token rather than a permanent System User one. Every call on
 * every Meta channel fails identically until it is replaced, so saying that
 * once, in the error itself, is the difference between a five-minute fix and an
 * afternoon spent reading Meta's documentation.
 */
export const ACCESS_TOKEN_CODE = 190;

/** How to get out of an expired-token state, appended to Meta's own wording. */
export function explainAuthError(code: number | null, message: string): string {
  if (code !== ACCESS_TOKEN_CODE) return message;

  return (
    `${message}\n\nMETA_PAGE_ACCESS_TOKEN is expired or revoked, so every ` +
    `WhatsApp, Messenger and Instagram call fails until it is replaced — one ` +
    `Meta app serves all three, so they share the one token. Short-lived user ` +
    `tokens last about 24 hours; issue a System User token in Meta Business ` +
    `Manager, which does not expire, and set it in the shipblu-support-production ` +
    `environment group.`
  );
}

export type ErrorContext = {
  /** Our own view of the window, from the customer's last inbound message. */
  windowOpen: boolean;
  /** The number the conversation arrived on. */
  inboundPhoneNumberId?: string | null;
  /** The number the message actually went out from. */
  sentFromPhoneNumberId?: string | null;
};

/**
 * Appends a plain explanation when Meta's text would mislead. Returns the
 * original text unchanged when it is already accurate — an agent who has seen
 * one annotation should be able to trust that the unannotated ones mean what
 * they say.
 */
export function explainDeliveryError(
  code: number | null,
  message: string,
  context: ErrorContext,
): string {
  // An expired token fails every send identically, so an agent looking at a
  // failed message should be told it is a credential rather than anything they
  // did or the customer did.
  if (code === ACCESS_TOKEN_CODE) return explainAuthError(code, message);

  if (code !== RE_ENGAGEMENT_CODE) return message;

  const mismatched =
    Boolean(context.inboundPhoneNumberId) &&
    Boolean(context.sentFromPhoneNumberId) &&
    context.inboundPhoneNumberId !== context.sentFromPhoneNumberId;

  if (mismatched) {
    return (
      `${message}\n\nThis reply went out from business number ` +
      `${context.sentFromPhoneNumberId} but the customer wrote to ` +
      `${context.inboundPhoneNumberId}. The 24-hour window belongs to a pair of ` +
      `numbers, so a reply from the wrong one is treated as a new conversation. ` +
      `Check WHATSAPP_PHONE_NUMBER_ID.`
    );
  }

  if (context.windowOpen) {
    return (
      `${message}\n\nThe customer messaged us well within 24 hours, so this is ` +
      `almost certainly the reply going out from a different business number ` +
      `than the one they wrote to. Check WHATSAPP_PHONE_NUMBER_ID.`
    );
  }

  return message;
}
