import type { MetaThreadState } from './thread';
import { describeWindow, type MetaWindowState } from './window';

/**
 * Why "Take thread control" would do nothing useful on this ticket, or null when
 * pressing it can.
 *
 * The one statement of when the button is offered, asked by the composer to
 * draw it and by `claimThreadControl` to refuse a press, because those two
 * disagreeing is exactly how five presses on Instagram tickets became five 500s
 * (`docs/PROJECT-STATE.md` §6.111). Client-safe — the thread verdict is a type
 * here, and `window.ts` is pure — since the composer is a client component.
 *
 * Two refusals, in order:
 *
 * - **The verdict says taking control cannot change it** (`canTakeControl`:
 *   only a Messenger standby over the Page connection). The refusal is the
 *   verdict's own explanation, so the advice under the button cannot differ
 *   from the paragraph above it.
 * - **The seven days are gone.** Nothing can be sent on the thread whoever owns
 *   it, so taking it would only take it from the tool answering there, which
 *   sees a thread go quiet for nothing. Only `expired`: a thread with no
 *   customer message (`never_opened`) has no standby to take and nobody to
 *   address, which the action's own recipient check says better.
 *
 * `window` is null where the clock is not known yet — the composer before it
 * mounts — and is then taken as open, as the composer takes it everywhere else:
 * a button that appears and is withdrawn on the first tick corrects itself, and
 * the action asks again with the server's clock.
 */
export function takeControlRefusal(
  thread: MetaThreadState,
  window: MetaWindowState | null,
): string | null {
  if (!thread.canTakeControl) {
    return (
      'Thread control cannot be taken on this ticket.' +
      (thread.explanation ? `\n\n${thread.explanation}` : '')
    );
  }

  if (window?.reason === 'expired') {
    return `${describeWindow(window)} Taking thread control would only take it from the other tool.`;
  }

  return null;
}
