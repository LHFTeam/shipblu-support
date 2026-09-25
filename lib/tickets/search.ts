/**
 * What an agent's search box entry means.
 *
 * Parsing lives here rather than inline in the query so it can be tested
 * without a database, and so the inbox and anything else that grows a search
 * agree on what "#812" or a pasted phone number is.
 */

import { detectShipmentRefs, shipmentPatterns } from '@/lib/shipments/detect';
import { couldBeReference, normaliseSbid, normaliseTrackingNumber } from '@/lib/shipments/format';
import { containing } from '@/lib/search/like';

export type SearchTerm = {
  /** ILIKE pattern for free-text columns. Wildcards in the query are literal. */
  pattern: string;
  /**
   * The ticket number the query names, if it names one. "#812" is how the team
   * refers to a ticket, so it earns an exact match on the number rather than a
   * substring search that happens to hit a subject.
   */
  number: number | null;
  /**
   * A digits-only pattern for phone columns, set only when the query carries
   * punctuation the stored number does not. Numbers arrive in E.164 digits
   * (`201014428154`), but agents paste them the way WhatsApp and the shipping
   * system show them — `+20 101 442 8154`, `0101-442-8154` — and every one of
   * those matched nothing.
   */
  phonePattern: string | null;
  /**
   * A tracking number, exact and canonical. Set by a `track:` prefix, or by a
   * bare query that is one reference and nothing else.
   */
  trackingNumber: string | null;
  /** An SBID, exact and canonical, from an `sbid:` prefix or a bare query. */
  sbid: string | null;
  /**
   * What the query is asking for.
   *
   * A prefix narrows the search to that one clause and nothing else, which is
   * the point of typing it: `track:SB123456789` becomes a single unique-index
   * probe instead of a trigram scan of every message body in the account. An
   * unprefixed query stays `any`, so the shipment clauses join the existing
   * five rather than replacing them.
   */
  scope: 'any' | 'tracking' | 'sbid';
};

const TRACKING_PREFIXES = ['track:', 'tracking:', 'awb:'];
const SBID_PREFIXES = ['sbid:', 'account:'];

function stripPrefix(query: string, prefixes: readonly string[]): string | null {
  const lower = query.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) return query.slice(prefix.length).trim();
  }
  return null;
}

/** Anything that shows up between the digits of a written-down phone number. */
const PHONE_PUNCTUATION = /^[\d+()\-.\s]+$/;

export function parseSearchTerm(query: string): SearchTerm {
  const raw = query.trim();

  // A prefix narrows the search. An empty or unusable value after one degrades
  // to an ordinary text search rather than returning nothing — someone
  // mid-typing "track:" should see their old results, not an empty inbox.
  const trackingRest = stripPrefix(raw, TRACKING_PREFIXES);
  if (trackingRest !== null) {
    const trackingNumber = normaliseTrackingNumber(trackingRest);
    if (couldBeReference(trackingNumber)) {
      return { ...textTerm(trackingRest), trackingNumber, sbid: null, scope: 'tracking' };
    }
    return textTerm(trackingRest);
  }

  const sbidRest = stripPrefix(raw, SBID_PREFIXES);
  if (sbidRest !== null) {
    const sbid = normaliseSbid(sbidRest);
    if (couldBeReference(sbid)) {
      return { ...textTerm(sbidRest), trackingNumber: null, sbid, scope: 'sbid' };
    }
    return textTerm(sbidRest);
  }

  const term = textTerm(raw);

  // Without a prefix, infer — but only when the whole query is one reference
  // and nothing else. Reusing the detector is the point: one definition of what
  // a tracking number looks like, shared by ingest, search and the backfill.
  const found = detectShipmentRefs(raw, shipmentPatterns());
  const isWholeQuery = (value: string) => normaliseTrackingNumber(raw) === value;

  if (found.trackingNumbers.length === 1 && isWholeQuery(found.trackingNumbers[0]!)) {
    term.trackingNumber = found.trackingNumbers[0]!;
  }
  if (found.sbids.length === 1 && normaliseSbid(raw) === found.sbids[0]!) {
    term.sbid = found.sbids[0]!;
  }

  return term;
}

/** The free-text half, which every branch above needs. */
function textTerm(query: string): SearchTerm {
  const q = query.trim();

  const asTicket = /^#?(\d+)$/.exec(q);
  // Number() would also accept "1e3" and " 12.0 ", which are not ticket
  // numbers anybody types. Postgres bigints are what this is compared against,
  // so anything past the safe integer range is not one either.
  const number =
    asTicket && Number(asTicket[1]) > 0 && Number(asTicket[1]) <= Number.MAX_SAFE_INTEGER
      ? Number(asTicket[1])
      : null;

  const digits = q.replace(/\D/g, '');
  const looksLikePhone = PHONE_PUNCTUATION.test(q) && digits.length >= 6;

  return {
    pattern: containing(q),
    number,
    // Only when the punctuation actually got in the way: for a query that is
    // already bare digits the free-text pattern covers the phone column too.
    phonePattern: looksLikePhone && digits !== q ? containing(digits) : null,
    trackingNumber: null,
    sbid: null,
    scope: 'any',
  };
}
