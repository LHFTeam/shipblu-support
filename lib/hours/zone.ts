/**
 * The zone the team works in.
 *
 * What a timestamp is shown in, what a typed date and time is read in, and what
 * a report's day is bucketed in, wherever no schedule is loaded to say
 * otherwise — never the server's zone, which on Render is UTC, and never the
 * reader's browser's. A schedule's own `timezone` still wins where one is in
 * hand; this is the answer when none is, and the zone a new schedule starts in.
 *
 * Declared once because it was written out eleven times, as a local `ZONE`,
 * `TIMEZONE` or bare literal in each module that needed it. A second office is
 * a decision to make here, not a search for the string.
 *
 * No imports, so a client component can read it without pulling luxon or the
 * rest of `lib/hours` into the browser bundle.
 */
export const TEAM_TIME_ZONE = 'Africa/Cairo';
