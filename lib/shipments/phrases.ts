import { db } from '@/db/client';
import { shipmentPhrases } from '@/db/schema';
import type { PhraseOverrides } from './status';

/**
 * The Arabic wording an admin has chosen, for the pages that draw it.
 *
 * Separate from `status.ts` because that module is imported by the worker and
 * tested with no database at all. Keeping the table there and the query here is
 * what lets `statusLabel` stay a pure function of its arguments: the one caller
 * that needs an admin's wording — the public tracking page — loads it and hands
 * it over.
 *
 * Read on every request rather than cached. The table holds one row per phrase
 * somebody has overridden, which is a handful at most and usually none, and the
 * page is already `force-dynamic` and already waiting on a call to
 * `api.shipblu.com`; a cache would trade a free query for an admin wondering why
 * their edit has not appeared. If this ever stops being free, cache it here
 * rather than in the page, so both readers get the same answer.
 *
 * Never throws. A tracking page whose whole job is to answer one question must
 * not fail to answer it because a wording override could not be read — the
 * defaults compiled into `status.ts` are a complete vocabulary on their own, so
 * the fallback is the page as it shipped rather than a page with holes in it.
 */
export async function phraseOverrides(): Promise<PhraseOverrides> {
  try {
    const rows = await db
      .select({ key: shipmentPhrases.key, ar: shipmentPhrases.ar })
      .from(shipmentPhrases);

    return Object.fromEntries(rows.map((row) => [row.key, row.ar]));
  } catch {
    return {};
  }
}
