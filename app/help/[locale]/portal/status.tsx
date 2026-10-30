import { Badge, type BadgeTone } from '@/components/ui';
import { type Locale } from '@/lib/kb/locale';
import { categoryWord } from '@/lib/portal/status-words';
import type { StatusCategory } from '@/lib/tickets/vocabulary';

/**
 * A ticket's state as the customer should see it.
 *
 * Falls back to a plain word for the status *category* (`categoryWord`)
 * whenever the configured status has no customer label or is marked
 * internal-only — `listTickets` and `getTicket` send null for both, and never
 * the status's name. Agents name statuses for themselves — "Waiting on ops",
 * "Escalated tier 2" — and those names are a running commentary on our own
 * operations that no customer asked for. The category still tells them the one
 * thing they want to know: is anyone still on this.
 */
// Keyed by the vocabulary, as the words are, so a category added there fails
// to compile here until it has a tone, rather than drawing without one.
const TONES: Record<StatusCategory, BadgeTone> = {
  open: 'open',
  pending: 'pending',
  resolved: 'resolved',
  closed: 'closed',
};

export function StatusBadge({
  locale,
  label,
  category,
}: {
  locale: Locale;
  label: string | null;
  category: StatusCategory;
}) {
  return <Badge tone={TONES[category]}>{label ?? categoryWord(category, locale)}</Badge>;
}
