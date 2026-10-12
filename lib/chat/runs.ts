/**
 * Where each message sits in a run of consecutive messages from one sender.
 *
 * A chat thread joins a run into one block: the author line on the first
 * bubble, the avatar, time and receipt on the last, two pixels between them
 * rather than fourteen. That is a question about the neighbours of a message,
 * not about the message, so it is answered once over the whole list rather than
 * by each caller peeking at `items[i - 1]` — the console, the widget and the
 * portal all draw runs, and three hand-written lookbehinds would be three ways
 * of disagreeing about the edge of one.
 *
 * The key is whatever makes two messages "the same sender" on that surface —
 * direction and author in the console, `from` and name in the widget — and a
 * caller that wants a long silence to break a run folds the gap into the key.
 * `null` means "not a bubble": a day break, an event line, a side conversation.
 * It stands alone and breaks the run on both sides, because a bubble resuming
 * after "Assigned to Mariam" is a new block even when Mariam wrote both.
 */
export type RunPosition = 'single' | 'first' | 'middle' | 'last';

export function runPositions(keys: readonly (string | null)[]): RunPosition[];
export function runPositions<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null,
): RunPosition[];
export function runPositions<T>(
  items: readonly T[],
  keyOf?: (item: T) => string | null,
): RunPosition[] {
  const keys = keyOf ? items.map(keyOf) : (items as readonly (string | null)[]);

  return keys.map((key, index) => {
    if (key === null) return 'single';
    const joinsPrevious = index > 0 && keys[index - 1] === key;
    const joinsNext = index < keys.length - 1 && keys[index + 1] === key;

    if (joinsPrevious && joinsNext) return 'middle';
    if (joinsPrevious) return 'last';
    if (joinsNext) return 'first';
    return 'single';
  });
}
