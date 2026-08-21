/**
 * A place a customer sent us, and where it points.
 *
 * Named for what it is — a location *shared with us* — to keep it clear of
 * `lib/locations`, which is the register of ShipBlu's own hubs. The two words
 * mean opposite things here: one is a pin dropped by a customer, the other is a
 * warehouse we operate.
 *
 * One module because three callers need the same answers — the ingest path that
 * stores a pin, the console that renders it, and the backfill that repairs the
 * archive — and "what counts as a usable coordinate" answered three ways is how
 * one of them ends up pointing an agent at the wrong side of the planet.
 *
 * Deliberately importing nothing. It is reached from a client component, and the
 * note in `channel-policy.ts` applies for the same reason: importing a value
 * from a module that touches `db/client` or `env()` drags the Postgres driver
 * into the browser bundle and fails the build.
 */

/** What lives at `messages.meta.location`. */
export type SharedLocation = {
  latitude: number;
  longitude: number;
  /** The place name, when the customer picked a place rather than dropping a pin. */
  name: string | null;
  /** Meta's geocoded address, when it sends one. */
  address: string | null;
};

/**
 * A coordinate pair, or null if it is not one.
 *
 * The range check is the point. Meta's own field is `number`, but this reads
 * webhook JSON and a stored jsonb blob, so it has to survive a string, a null,
 * an infinity and a transposed pair. An out-of-range value is not a place, and
 * the failure it causes is the quiet kind: a map link built from it still opens,
 * still shows somewhere real, and is wrong — which nobody goes looking for. The
 * same asymmetry that made `lib/shipments/detect.ts` conservative applies, so an
 * unusable pair is dropped rather than clamped into a plausible one.
 */
export function parseCoordinates(
  latitudeInput: unknown,
  longitudeInput: unknown,
): { latitude: number; longitude: number } | null {
  const latitude = finiteNumber(latitudeInput);
  const longitude = finiteNumber(longitudeInput);

  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  return { latitude, longitude };
}

/**
 * The location on a message's `meta`, or null when there is not a usable one.
 *
 * Validated rather than cast, because `meta` is jsonb: its contents are whatever
 * some earlier version of this code, a backfill or a person at a psql prompt
 * put there. This is the trust boundary for every reader.
 */
export function readSharedLocation(meta: unknown): SharedLocation | null {
  if (!isObject(meta)) return null;

  const raw = (meta as { location?: unknown }).location;
  if (!isObject(raw)) return null;

  const fields = raw as Record<string, unknown>;
  const coordinates = parseCoordinates(fields.latitude, fields.longitude);
  if (!coordinates) return null;

  return {
    ...coordinates,
    name: trimmedOrNull(fields.name),
    address: trimmedOrNull(fields.address),
  };
}

/**
 * Six decimal places — about 11 cm, and far finer than a delivery address needs.
 *
 * Meta sends fourteen significant digits, which is float noise past the first
 * six and reads as false precision on the screen.
 */
const PRECISION = 6;

function round(value: number): string {
  // Number() again to drop trailing zeros: 30.5 rather than 30.500000.
  return String(Number(value.toFixed(PRECISION)));
}

export function formatCoordinates(location: SharedLocation): string {
  return `${round(location.latitude)}, ${round(location.longitude)}`;
}

/**
 * A map link for a shared pin.
 *
 * Coordinates only, never the name. Google resolves a name query to whatever it
 * thinks the words mean, and the name here is text a customer typed — so a
 * pin in Sohag with a name like "Cairo office" would open a map of Cairo. The
 * coordinates are the thing the customer actually pointed at, and they are
 * unambiguous; the name is shown beside the link instead.
 *
 * Google's documented cross-platform URL, so it hands off to the Maps app on a
 * phone — which is where an agent chasing an address usually wants it.
 */
export function mapUrl(location: SharedLocation): string {
  const query = `${round(location.latitude)},${round(location.longitude)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  // A numeric string is tolerated because this parses two different sources —
  // Meta's webhook and our own jsonb — and only one of them is typed. Blank is
  // excluded explicitly: Number('') is 0, which would put the Gulf of Guinea on
  // every message that arrived with an empty field.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
