/**
 * Print every inbound webhook delivery, verbatim, when `LOG_ALL_INCOMING_WEBHOOKS`
 * is `true`.
 *
 * Off by default and meant to be switched on for a debugging session and back
 * off again — not left running. It exists because the single most expensive
 * question in this system has repeatedly been the cheapest one to answer wrong:
 * **did the delivery arrive at all?** Three separate investigations
 * (`docs/PROJECT-STATE.md` §6.26, §6.33, §6.34) each spent hours inside the
 * parser for events that had never reached the endpoint, because the only
 * evidence available was a `webhook_events` row that is written *after* the
 * signature check and skipped entirely for a duplicate. A payload nobody can see
 * is indistinguishable from a payload nobody sent.
 *
 * So this logs at the very top of the handler — **before** signature
 * verification, before JSON parsing, before the duplicate check — and nothing
 * downstream can suppress it. That ordering is the whole feature: a delivery
 * dropped for a bad signature, a body that is not JSON, and a redelivery that
 * collides on its id all look identical in the database and all appear here.
 *
 * The cost is honest and worth stating: **this puts customer message content,
 * names and phone numbers into the Render log**, which is a less protected place
 * than the database. That is inherent — a redacted payload could not answer the
 * question this exists for. Credentials are the exception and are always
 * stripped; see `REDACTED_HEADERS`.
 */

/** Longest body printed. Beyond this the line says how much it dropped. */
const MAX_BODY = 8000;

/**
 * Headers never printed, whatever the flag says.
 *
 * `authorization` is not hypothetical here: the Postmark webhook authenticates
 * with **Basic Auth**, so the inbound email endpoint receives
 * `EMAIL_WEBHOOK_SECRET` on every single delivery. Printing headers naively
 * would copy that credential into the log on the busiest inbound path in the
 * system, which is exactly the "never echo a credential in any direction" rule
 * in `AGENTS.md`.
 *
 * `x-hub-signature-256` is deliberately **kept**. It is an HMAC rather than a
 * secret, the existing routes already persist it on the same reasoning — it is
 * the evidence — and a signature mismatch is one of the failures this tool is
 * for. Seeing that the header was absent entirely, which is what a misrouted
 * delivery looks like, is worth as much as seeing it not match.
 */
const REDACTED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key']);

/** Whether the flag is on right now. */
export function shouldLogIncomingWebhooks(): boolean {
  /*
    `process.env` directly rather than `env()`, following the precedent
    `AGENTS.md` records for `lib/shipments/detect.ts`: `env()` validates the
    whole schema, and a diagnostic must not be able to fail a webhook it was
    only ever meant to describe. The variable is still declared in `lib/env.ts`
    so it is discoverable and paired with `render.yaml`.
  */
  return process.env.LOG_ALL_INCOMING_WEBHOOKS === 'true';
}

export type IncomingWebhook = {
  /** Which endpoint received it — `meta`, `whatsapp`, `email:postmark`. */
  source: string;
  method: string;
  url: string;
  headers: Headers;
  rawBody: string;
};

/**
 * The lines to print for one delivery.
 *
 * Pure, and separate from the printing, because the redaction is the part with a
 * security consequence and a rule with no test is a rule that quietly stops
 * holding.
 */
export function describeIncomingWebhook(delivery: IncomingWebhook): string[] {
  const path = safePath(delivery.url);
  const lines = [`[webhook:all] ${delivery.source} ${delivery.method} ${path}`];

  const names = [...delivery.headers.keys()].sort();
  for (const name of names) {
    const key = name.toLowerCase();
    const value = REDACTED_HEADERS.has(key) ? '[redacted]' : delivery.headers.get(name);
    lines.push(`[webhook:all]   ${key}: ${value}`);
  }

  const body = delivery.rawBody;
  lines.push(`[webhook:all]   ${body.length} byte body:`);

  if (body.length <= MAX_BODY) {
    lines.push(body || '(empty)');
  } else {
    // Truncated rather than dropped, and it says by how much: a body that is
    // merely long is still worth most of its first 8 KB, and a silent cut would
    // be read as a malformed payload.
    lines.push(
      `${body.slice(0, MAX_BODY)}\n[webhook:all]   … ${body.length - MAX_BODY} more bytes`,
    );
  }

  return lines;
}

/**
 * Print the delivery if the flag is on.
 *
 * Never throws. A diagnostic that can take down the endpoint it is watching is
 * worse than no diagnostic, and this one runs before the signature check on
 * every inbound delivery in the system.
 */
export function logIncomingWebhook(delivery: IncomingWebhook): void {
  if (!shouldLogIncomingWebhooks()) return;

  try {
    console.log(describeIncomingWebhook(delivery).join('\n'));
  } catch (error) {
    console.warn(
      `[webhook:all] could not log the ${delivery.source} delivery: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The path and query, without the origin.
 *
 * `request.url` is the address the *server* is bound to rather than the one the
 * client used (§6.24), so printing it whole invites the same misreading that
 * entry describes. The path is the part that is actually true.
 */
function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
