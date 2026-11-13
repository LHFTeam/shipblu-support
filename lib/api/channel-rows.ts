import { filingRowOfType } from '@/lib/routing/filing';

/**
 * Which `api` row the myBlu app files under, and what switching one on or off
 * does to that (`plans/myblu-ticket-api.md`, stage 2).
 *
 * The app reads the oldest active `api` row (`apiChannel`): its default group,
 * and with it the hours the app is told, and its routing mode. Every other row
 * files nothing. So a switch is about more than its own row, as web chat's is:
 * switching the app's row off hands the app to the next oldest active one, and
 * switching on a row older than the app's takes the app over. Unlike web
 * chat's, switching off the last active row is allowed and is what the switch
 * is for: with none, the plan's `POST /tickets` answers `503 not_configured`
 * while reads and replies on the tickets the app has go on.
 *
 * Kept apart from `lib/widget/rows.ts` rather than made one module with it:
 * the two agree on which row files (`filingRowOfType`, which both ask) and on
 * nothing else — the widget refuses its last row and reports its FAQ folders,
 * and the app has neither. Pure, so the page words the confirmation and
 * `switchApiChannel` says what happened by the same rule, and both are tested
 * without a database.
 *
 * Rows are passed oldest first, ties by id, the order `apiChannel` reads them
 * in: on the page the list's rows in `routingReadiness`'s order, in the switch
 * its own read.
 */
export type ApiRow = { id: string; type: string; name: string; isActive: boolean };

/** The row the app files under: the oldest active one, or none. The routing panel's rule. */
export function appRow<T extends ApiRow>(rows: readonly T[]): T | null {
  return filingRowOfType('api', rows);
}

/** What switching one row would do. */
export type ApiSwitch<T extends ApiRow = ApiRow> =
  /**
   * On now. `appMovesTo` is where the app goes when this is its row and
   * another is on, and null when it stays where it is or has nowhere to go;
   * `last` when no other row is on, so the app stops opening tickets.
   */
  | { kind: 'switch_off'; appMovesTo: T | null; last: boolean }
  /** Off now; `takesApp` when it is older than the app's row, or the app has none. */
  | { kind: 'switch_on'; takesApp: boolean };

/** What switching `id` would do, or null when no row has it. */
export function apiSwitch<T extends ApiRow>(rows: readonly T[], id: string): ApiSwitch<T> | null {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) return null;

  const app = appRow(rows);
  if (!row.isActive) {
    // Oldest first, so the first active row after switching this one on is
    // this one exactly when it comes before the app's row, or there is none.
    return { kind: 'switch_on', takesApp: app === null || rows.indexOf(row) < rows.indexOf(app) };
  }

  const others = rows.filter((candidate) => candidate.id !== id);
  return {
    kind: 'switch_off',
    appMovesTo: app === row ? appRow(others) : null,
    last: !others.some((candidate) => candidate.isActive),
  };
}

/**
 * The `api` rows as a switch's answer speaks about them: which are on. The
 * action answers with it as the switch left them and the page draws it from
 * its own rows, so a row's switch shows its answer only while the two agree —
 * "the app now uses B" is no longer true once another switch has moved it, nor
 * "no row is on" once one has been added. Order-free, since only the states
 * are compared.
 */
export function apiStateKey(rows: readonly ApiRow[]): string {
  return rows
    .map((row) => `${row.id}:${row.isActive ? 'on' : 'off'}`)
    .sort()
    .join(',');
}

/**
 * What the admin is told once a row has been switched. `rows` are as they were
 * before the switch, `active` is what the row was switched to.
 *
 * The last row going off says what that does and what it does not, since it
 * is the one switch here that changes what a customer can do: the app opens no
 * new ticket, and the tickets it has go on.
 */
export function apiSwitchNotice(rows: readonly ApiRow[], id: string, active: boolean): string {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) return '';
  const name = `“${row.name}”`;
  const before = appRow(rows);
  const after = appRow(
    rows.map((candidate) => (candidate.id === id ? { ...candidate, isActive: active } : candidate)),
  );

  if (!active) {
    if (!after) {
      return `${name} is off, and no myBlu app row is on: the app cannot open a new ticket until one is. Customers keep reading and replying on the tickets they have.`;
    }
    if (after.id === before?.id) return `${name} is off. The app still uses “${after.name}”.`;
    return `${name} is off, and the app now opens its tickets under “${after.name}”, the oldest active myBlu app row.`;
  }

  if (after?.id === id) {
    return `${name} is on, and the app opens its new tickets under it, as the oldest active myBlu app row.`;
  }
  return `${name} is on, but the app still uses “${after?.name ?? ''}”, the oldest active myBlu app row, so nothing is filed under this one.`;
}
