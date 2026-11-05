/**
 * `text` with every occurrence of each secret cut out.
 *
 * One function for the three places that repeat what Meta or the network said
 * about a request that carried a credential — the token inspection, the two
 * code exchanges — so how a secret is cut out of a sentence is decided once.
 * An empty secret is skipped, since splitting on it would put a marker between
 * every character.
 *
 * `minLength` is the one choice that differs by caller, and it is a parameter
 * rather than a second function. The token inspection passes 16: it is handed
 * tokens from the environment, a Meta token runs to well over a hundred
 * characters, and cutting a five-letter test value out of "debug_token failed"
 * turns the sentence into nonsense without protecting anything. The exchanges
 * pass nothing: every secret they hold was sent to Meta by them, and must never
 * repeat, however short a misconfigured one is.
 */
export function redact(text: string, secrets: readonly string[], minLength = 0): string {
  return secrets.reduce(
    (out, secret) =>
      secret && secret.length >= minLength ? out.split(secret).join('[redacted]') : out,
    text,
  );
}
