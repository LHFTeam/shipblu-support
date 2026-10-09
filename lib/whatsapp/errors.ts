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

/**
 * Which credential a WhatsApp call authenticated with — see
 * `resolveCredentialSource` in ./accounts, which decides it.
 *
 *   stored    sealed in the database when the number was connected through
 *             Meta's Embedded Signup
 *   variable  a `WHATSAPP_TOKEN_*` variable the account names
 *   shared    `META_PAGE_ACCESS_TOKEN`
 */
export type CredentialSource = 'stored' | 'variable' | 'shared';

/** Enough to say which credential to fix, and nothing else of it. */
export type TokenOrigin = { source: CredentialSource; tokenEnvVar?: string | null };

/**
 * How to get out of an expired-token state, appended to Meta's own wording.
 *
 * The sentence depends on which credential was refused, because the fixes are
 * in three different places and blaming the wrong one is how an afternoon goes:
 * a stored credential is renewed by signing in through Meta again, and nothing
 * on Render will help it; a named variable is replaced on Render, and only for
 * the one account; the shared token stops every Meta channel at once.
 */
export function explainAuthError(
  code: number | null,
  message: string,
  origin: TokenOrigin = { source: 'shared' },
): string {
  if (code !== ACCESS_TOKEN_CODE) return message;

  if (origin.source === 'stored') {
    return (
      `${message}\n\nThe credential stored for this WhatsApp business account when it ` +
      `was connected through Meta is expired or revoked — it reached its expiry, or ` +
      `the business removed this app under Business Settings → Integrations → ` +
      `Connected apps. Every call on this account fails until the number is ` +
      `reconnected through Meta under Settings → Channels. Nothing in the ` +
      `environment needs to change, and the other accounts are unaffected.`
    );
  }

  if (origin.source === 'variable' && origin.tokenEnvVar) {
    return (
      `${message}\n\n${origin.tokenEnvVar}, the access token this WhatsApp business ` +
      `account names, is expired or revoked, so every call on this account fails ` +
      `until it is replaced. Short-lived user tokens last about 24 hours; issue a ` +
      `System User token in Meta Business Manager, which does not expire, and set ` +
      `it as ${origin.tokenEnvVar} in the shipblu-support-production environment group.`
    );
  }

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
  //
  // The status webhook this is called from does not say which credential the
  // send used, so this names the shared one — the sentence `send_whatsapp`
  // records at send time is the one that knows.
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
