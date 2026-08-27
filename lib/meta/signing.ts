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
 * Which envelope a delivery arrived in.
 *
 * Not a detail: `messaging` and `standby` are the handover protocol's two
 * channels — the first means this app holds thread control, the second means
 * another one does — and on this deployment **they are signed with different
 * secrets**, which is the fact the notice below exists to surface.
 */
export function deliveryEnvelope(payload: {
  entry?: { messaging?: unknown[]; standby?: unknown[]; changes?: unknown[] }[];
}): string {
  const entry = payload.entry?.[0];
  if (entry?.messaging?.length) return 'messaging';
  if (entry?.standby?.length) return 'standby';
  if (entry?.changes?.length) return 'changes';
  return 'empty';
}

/**
 * Says which secret is verifying Instagram deliveries, once per combination of
 * secret and envelope.
 *
 * Written because its absence cost an answer. When the outage in
 * `docs/PROJECT-STATE.md` §6.26 ended, the deliveries started verifying again
 * and there was no way to tell *how*: a corrected Instagram app secret and an
 * account moved back onto its Facebook Page produce the identical
 * `signature_verified = true`, and those are different configurations with
 * different App Review permissions.
 *
 * The first version of this remembered one name and re-announced on change,
 * on the reasoning that a signing secret changes on the order of never. **That
 * was wrong within the hour.** Both secrets are in use on this deployment at
 * once — the `messaging` copies and the `standby` copies of the same account's
 * traffic are signed differently — so "re-announce on change" became a line per
 * delivery, which is precisely the noise the once-only design existed to avoid.
 *
 * Keyed on secret *and* envelope instead. That bounds the output at a handful of
 * lines for the life of a process and makes each one worth reading, because the
 * pair is the whole answer: which credential signs which channel. The trade is
 * that a return to a combination already reported is silent — acceptable, since
 * the set of combinations is what anybody is trying to learn here, not the
 * sequence.
 */
const noted = new Set<string>();

export function noteVerifyingSecret(
  object: string | undefined,
  name: string,
  envelope: string,
): void {
  // Only Instagram has two possible signers, and the other two objects carry
  // the overwhelming majority of the traffic.
  if (object !== 'instagram') return;

  const key = `${name}:${envelope}`;
  if (noted.has(key)) return;

  noted.add(key);
  console.log(`[webhook:meta] instagram ${envelope} deliveries are verifying with ${name}`);
}

/** Test-only, as `resetEnvCache` is: module state outlives a single test. */
export function resetVerifyingSecretNotice(): void {
  noted.clear();
}

/** What the rejection log and the stored row say, given what was tried. */
export function unverifiedReason(candidates: SigningCandidate[]): string {
  if (candidates.length === 0) {
    return 'signature not verified: no app secret is configured (META_APP_SECRET)';
  }

  return `signature did not match ${candidates.map((candidate) => candidate.name).join(' or ')}`;
}
