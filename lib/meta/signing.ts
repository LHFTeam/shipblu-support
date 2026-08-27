/**
 * Which app secret an inbound Meta delivery is signed with.
 *
 * One Meta app was assumed to mean one signing secret, and for WhatsApp,
 * Messenger and a Page-connected Instagram account that is true. It stops being
 * true the moment an Instagram professional account is connected through
 * **Instagram Login** instead: that setup issues its own *Instagram app secret*
 * — a separate value from the app's Basic-settings app secret — and signs the
 * `instagram` object's deliveries with it.
 *
 * Nothing about the payload says which one was used. The object, the entry id,
 * the headers and the user agent are identical either way, so a mismatch shows
 * up only as `signature_verified = false`, which the endpoint answers with 403
 * and stores as evidence. That is what happened here: from 2026-08-26 07:37 UTC
 * every single Instagram delivery failed verification — 2,309 of them in
 * thirteen hours, including real customers' messages — while Facebook's kept
 * verifying against the same unchanged secret. Nothing alerted, because a
 * rejected forgery and a rejected genuine delivery were the same event.
 *
 * So the candidates are tried in order rather than one being chosen. Both
 * belong to us; accepting a delivery signed by either is not a weakening, and it
 * is what lets an account be moved between the two setups without a deploy
 * timed to the minute. The *names* travel with the values so a failure can say
 * which variables were tried without ever printing one.
 */

export type SigningCandidate = {
  /** The environment variable name, for the log line. Never the value. */
  name: string;
  secret: string;
};

export type SigningSecrets = {
  appSecret: string | undefined;
  /** From Instagram → API setup with Instagram login. */
  instagramAppSecret: string | undefined;
};

/**
 * The secrets worth trying for a delivery on `object`, most likely first.
 *
 * `object` is the webhook's own field — `instagram`, `page` or
 * `whatsapp_business_account` — read from the parsed body. Reading it means
 * parsing before verifying, which is safe: the signature covers the raw bytes
 * and those are untouched by having been read.
 */
export function signingCandidates(
  object: string | undefined,
  secrets: SigningSecrets,
): SigningCandidate[] {
  const app: SigningCandidate[] = secrets.appSecret
    ? [{ name: 'META_APP_SECRET', secret: secrets.appSecret }]
    : [];

  const instagram: SigningCandidate[] = secrets.instagramAppSecret
    ? [{ name: 'META_INSTAGRAM_APP_SECRET', secret: secrets.instagramAppSecret }]
    : [];

  // Only the `instagram` object can be signed by the Instagram app secret.
  // Offering it for a Page or WhatsApp delivery would spend an HMAC on a secret
  // that cannot be the right one, on the busiest path in the system.
  if (object !== 'instagram') return app;

  return [...instagram, ...app].filter(
    // A deployment that sets the same value under both names would otherwise
    // have every Instagram delivery hashed twice.
    (candidate, index, all) =>
      all.findIndex((other) => other.secret === candidate.secret) === index,
  );
}

/**
 * Says which secret is verifying Instagram deliveries — once, and again only if
 * it changes.
 *
 * Written because its absence cost an answer. When the outage in
 * `docs/PROJECT-STATE.md` §6.26 ended, the deliveries started verifying again
 * and there was no way to tell *how*: a corrected Instagram app secret and an
 * account moved back onto its Facebook Page produce the identical
 * `signature_verified = true`. Those are different configurations with different
 * App Review permissions (`instagram_business_manage_comments` versus
 * `instagram_manage_comments`), so the difference is not a curiosity — it decides
 * what gets submitted, and it was left to be guessed at.
 *
 * Once per process rather than per delivery, on the same reasoning as
 * `warnIfOnlyLegacy` in `lib/env.ts`: this is a fact about configuration, it
 * changes on the order of never, and 152,000 deliveries a week through the same
 * endpoint means anything logged per request is noise that trains people to
 * ignore the log. Module state, so each web instance says it once — with
 * autoscale at 1→3 that is at most three lines, which is a feature: it also
 * catches one instance running against stale configuration.
 */
let notedSecret: string | null = null;

export function noteVerifyingSecret(object: string | undefined, name: string): void {
  if (object !== 'instagram') return;
  if (name === notedSecret) return;

  notedSecret = name;
  console.log(`[webhook:meta] instagram deliveries are verifying with ${name}`);
}

/** Test-only, as `resetEnvCache` is: module state outlives a single test. */
export function resetVerifyingSecretNotice(): void {
  notedSecret = null;
}

/** What the rejection log and the stored row say, given what was tried. */
export function unverifiedReason(candidates: SigningCandidate[]): string {
  if (candidates.length === 0) {
    return 'signature not verified: no app secret is configured (META_APP_SECRET)';
  }

  return `signature did not match ${candidates.map((candidate) => candidate.name).join(' or ')}`;
}
