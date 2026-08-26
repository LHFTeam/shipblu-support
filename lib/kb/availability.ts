import { isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { widgetHours } from '@/lib/widget/session';

/**
 * Whether support is answering right now, for the public help centre.
 *
 * Read through `widgetHours()` rather than through `defaultHours()` directly,
 * and that is the whole point of the indirection: the chat launcher on this same
 * page is gated on that schedule. Two answers to "is anyone there?" on one
 * screen — a panel saying support is open above a launcher that says it is not —
 * is worse than either answer alone.
 *
 * Null when no schedule is configured at all. The caller renders nothing in that
 * case: a help centre with no business hours set has not said it is open around
 * the clock, it has said nothing, and printing either claim invents one.
 */
export type SupportAvailability = {
  open: boolean;
  /** When it opens next. Null while open, and null if nothing opens in a year. */
  opensAt: Date | null;
  /** The schedule's own timezone, so the caller prints the opening in it. */
  timezone: string;
};

export async function supportAvailability(): Promise<SupportAvailability | null> {
  const hours = await widgetHours();
  if (!hours) return null;

  const open = isWithinBusinessHours(hours);
  return { open, opensAt: open ? null : nextOpeningAt(hours), timezone: hours.timezone };
}
