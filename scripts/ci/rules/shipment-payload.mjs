import { fail, read, scannableSource, scan } from '../lib.mjs';

// ---------------------------------------------------------------------------
// The delivery platform's payload
//
// The tracking endpoint's ?pin= is not checked, so a tracking number is the only
// credential guarding the recipient's name, address, phone and COD amount. The
// payload therefore lands only in shipments.data, and exactly one module reads
// it back out — lib/shipments/detail.ts — which builds a fresh object from a
// named field list rather than spreading what it was given.
//
// A page picking its own fields off `data` makes the privacy promise only as
// good as the newest page, and /help/<locale>/track makes that promise in
// writing. This is §6.38.
// ---------------------------------------------------------------------------
export function checkShipmentPayloadConfinement() {
  const rule = 'shipment-payload';

  /**
   * lookup.ts selects the column and hands it straight to detail.ts without
   * looking inside it; sync.ts writes it; platform.ts produces it. Everything
   * else goes through publicTracking() or agentTracking().
   */
  const allowed = new Set([
    'lib/shipments/detail.ts',
    'lib/shipments/lookup.ts',
    'lib/shipments/sync.ts',
    'lib/shipments/platform.ts',
  ]);

  const candidates = scannableSource.filter((f) => !allowed.has(f) && !f.endsWith('.test.ts'));

  scan(candidates, /\bshipments\.data\b/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      'reads shipments.data directly — go through publicTracking() or agentTracking() in lib/shipments/detail.ts, which build a fresh object from a named field list',
    );
  });

  // The public shape must never grow a passthrough field. A `data` on
  // PublicTracking publishes the whole payload on a page anybody can open.
  const detail = read('lib/shipments/detail.ts');
  const publicType = detail.match(/export type PublicTracking = \{([\s\S]*?)\n\};/);
  if (!publicType) {
    fail(rule, 'lib/shipments/detail.ts', 'could not find the PublicTracking type');
  } else if (/^\s{2}(data|raw|payload|order)[?]?:/m.test(publicType[1])) {
    fail(
      rule,
      'lib/shipments/detail.ts',
      "PublicTracking has a passthrough field — the public tracking page would publish the recipient's name, address, phone and COD amount (§6.38)",
    );
  }

  /**
   * tracking_events arrive in no order at all, so nothing may treat a position
   * in the array as "latest". mapDeliveryOrder owns the ordering rules.
   */
  scan(
    scannableSource.filter(
      (f) =>
        f.includes('shipment') &&
        !f.endsWith('.test.ts') &&
        // platform.ts is the module that owns the ordering rule: `readEvents`
        // sorts by instant and `statusInstant` then reads the sorted array on
        // purpose. It is the one place allowed to index, because it is the only
        // place that has already sorted.
        f !== 'lib/shipments/platform.ts',
    ),
    /\bevents\s*\[\s*0\s*\]|\bevents\.at\(\s*-1\s*\)|\bevents\[events\.length\s*-\s*1\]/g,
    (file, line) => {
      fail(
        rule,
        `${file}:${line}`,
        'indexes into tracking events — the platform sends them in no order at all, so neither the first nor the last element is the latest',
      );
    },
  );
}
