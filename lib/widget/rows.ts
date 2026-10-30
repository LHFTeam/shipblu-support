import { filingRowOfType } from '@/lib/routing/filing';
import { parseWidgetConfig } from './config';

/**
 * Which web chat row the widget uses, and what switching one on or off does.
 *
 * The widget reads the oldest active web chat row (`webchatChannel`): its
 * default group, and with it the hours the widget and the help centre's home
 * page show, its FAQ folders and its routing mode. Every other row files
 * nothing, whatever it says. So switching a row is never only about that row:
 * switching the widget's row off hands the widget to the next oldest active
 * one, and switching on a row older than the widget's takes the widget over.
 *
 * The page asks this to word the confirmation, and `switchWebchatRow` asks it
 * again under its lock to say what happened, so the two cannot disagree. Pure,
 * so both are tested without a database.
 *
 * Rows are passed oldest first, ties by id, the order `webchatChannel` reads
 * them in: on the page the list's rows in `routingReadiness`'s order, in the
 * action the switch's own read.
 */
export type WebchatRow = { id: string; type: string; name: string; isActive: boolean };

/**
 * The row the widget uses: the oldest active one, or none. Asked of the
 * routing panel's rule (`filingRowOfType`), which says which row files a
 * type's tickets, so the card and the panel's warnings follow one rule.
 */
export function widgetRow<T extends WebchatRow>(rows: readonly T[]): T | null {
  return filingRowOfType('webchat', rows);
}

/** What switching one row would do. */
export type WebchatSwitch<T extends WebchatRow = WebchatRow> =
  /**
   * The only active row. Switching it off would leave the widget filing its
   * chats under no row and no group, and showing the default schedule, so it
   * is refused: another row goes on first.
   */
  | { kind: 'only_row' }
  /** On now; `widgetMovesTo` is where the widget goes, or null when it stays where it is. */
  | { kind: 'switch_off'; widgetMovesTo: T | null }
  /** Off now; `takesWidget` when it is older than the widget's row, which it then replaces. */
  | { kind: 'switch_on'; takesWidget: boolean };

/** What switching `id` would do, or null when no row has it. */
export function webchatSwitch<T extends WebchatRow>(
  rows: readonly T[],
  id: string,
): WebchatSwitch<T> | null {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) return null;

  if (!row.isActive) {
    const widget = widgetRow(rows);
    // Older than the widget's row, or there is none: oldest first, so the
    // first active row after switching this one on is this one.
    return {
      kind: 'switch_on',
      takesWidget: widget === null || rows.indexOf(row) < rows.indexOf(widget),
    };
  }

  const others = rows.filter((candidate) => candidate.id !== id);
  if (!others.some((candidate) => candidate.isActive)) return { kind: 'only_row' };
  return {
    kind: 'switch_off',
    widgetMovesTo: widgetRow(rows) === row ? widgetRow(others) : null,
  };
}

/** A row as the switch reports it: whether the widget would show its own questions. */
export type ReportedRow = WebchatRow & { hasFaqFolders: boolean };

/** A row read with its config, as the switch reports it. */
export function reportedRow<T extends WebchatRow & { config: unknown }>({
  config,
  ...row
}: T): Omit<T, 'config'> & ReportedRow {
  return { ...row, hasFaqFolders: Object.keys(parseWidgetConfig(config).faqFolders).length > 0 };
}

/**
 * The web chat rows as a switch's answer speaks about them: which are on, and
 * whether each lists questions. The action answers with it as it left them, and
 * the page draws it from its own rows, so a switch shows its answer only while
 * the two agree. Each row's switch keeps its answer for the life of the page,
 * and an answer about rows that have changed since is no longer true: "the
 * widget now uses B" once another switch has moved it, "B lists no FAQ
 * questions yet" once the card has chosen some, "the only active row" once
 * another has been added. Order-free, since only the rows' states are compared.
 */
export function webchatStateKey(rows: readonly ReportedRow[]): string {
  return rows
    .map((row) => `${row.id}:${row.isActive ? 'on' : 'off'}:${row.hasFaqFolders ? 'q' : '-'}`)
    .sort()
    .join(',');
}

/**
 * What the admin is told once a row has been switched. `rows` are as they were
 * before the switch, `active` is what the row was switched to.
 *
 * A row the widget moves onto may never have been configured as the widget's:
 * one added from the "add a channel" form saves no FAQ folders, and the widget
 * then shows the most-read articles. Said here, because the move is the moment
 * the admin can see it happen.
 */
export function switchNotice(rows: readonly ReportedRow[], id: string, active: boolean): string {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) return '';
  const name = `“${row.name}”`;
  const before = widgetRow(rows);
  const after = widgetRow(
    rows.map((candidate) => (candidate.id === id ? { ...candidate, isActive: active } : candidate)),
  );
  const questions = (target: ReportedRow) =>
    target.hasFaqFolders
      ? ''
      : ' It lists no FAQ questions yet, so the widget shows the most-read articles until some are chosen under Chat widget.';

  if (!active) {
    if (!after || after.id === before?.id) {
      return `${name} is off. The widget still uses “${after?.name ?? row.name}”.`;
    }
    return `${name} is off, and the widget now uses “${after.name}”, the oldest active web chat row.${questions(after)}`;
  }

  if (after?.id === id) {
    return `${name} is on, and the widget now uses it, as the oldest active web chat row.${questions(row)}`;
  }
  return `${name} is on, but the widget still uses “${after?.name ?? ''}”, the oldest active web chat row, so nothing is filed under this one.`;
}
