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
