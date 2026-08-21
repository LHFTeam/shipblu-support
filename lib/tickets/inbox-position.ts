import type { InboxFilters, InboxRow } from './queries';

/**
 * Where the agent had got to in the inbox, kept across one navigation.
 *
 * The list cannot simply stay mounted: `/inbox` and `/inbox/[number]` are
 * sibling segments, so opening a conversation replaces the whole page subtree
 * and React discards everything the list had accumulated — the older pages
 * scrolled into view and the scroll offset itself. Coming back landed the agent
 * at the top of a thirty-row list, which after scrolling a hundred rows into a
 * queue is indistinguishable from the list having reset itself.
 *
 * So the position lives outside React, here, and the list seeds itself from it
 * as it mounts. A module-level slot rather than `sessionStorage` because the
 * rows carry `Date`s that would need serialising and reviving on every write,
 * and remembering the offset means a write per scroll event — a synchronous
 * storage round trip on the main thread, while the agent is scrolling. The cost
 * is that a full reload starts at the top again, which is what a reload should
 * do.
 *
 * Keyed by the filter signature, because an offset only means anything in the
 * list it was measured in and a filter change is meant to go back to the top.
 * It is not per-agent state — but a module-level value on the server is shared
 * by every request, so the store is inert outside the browser rather than one
 * refactor away from seeding one agent's inbox with another's rows.
 */
export type InboxPosition = {
  signature: string;
  /** The pages below the server-rendered first one, in the order they arrived. */
  rows: InboxRow[];
  /** `undefined` until a page has been fetched; `null` once the end is known. */
  cursor: string | null | undefined;
  /** Offset of the list's own scroll box — the window never scrolls here. */
  scrollTop: number;
};

let remembered: InboxPosition | null = null;

/**
 * Which list this is, for both discarding and remembering.
 *
 * One function so the key the accumulated pages are reset on and the key the
 * position is stored under cannot drift apart — they are the same question.
 */
export function inboxSignature(filters: InboxFilters): string {
  return [filters.view, filters.statusCategory, filters.channel, filters.q].join('|');
}

export function readInboxPosition(signature: string): InboxPosition | null {
  if (typeof window === 'undefined') return null;
  return remembered?.signature === signature ? remembered : null;
}

export function rememberInboxPages(
  signature: string,
  rows: InboxRow[],
  cursor: string | null | undefined,
): void {
  const position = slot(signature);
  if (!position) return;
  position.rows = rows;
  position.cursor = cursor;
}

export function rememberInboxScroll(signature: string, scrollTop: number): void {
  const position = slot(signature);
  if (!position) return;
  position.scrollTop = scrollTop;
}

/** Drops the memory. Exported for tests; nothing in the app needs to forget. */
export function forgetInboxPosition(): void {
  remembered = null;
}

/**
 * The slot to write into, replaced wholesale when the filters have changed.
 *
 * Replacing rather than patching is what keeps a stale offset from surviving a
 * filter change: the pages and the offset are only consistent with each other
 * within one signature.
 */
function slot(signature: string): InboxPosition | null {
  if (typeof window === 'undefined') return null;
  if (remembered?.signature !== signature) {
    remembered = { signature, rows: [], cursor: undefined, scrollTop: 0 };
  }
  return remembered;
}
