import { Badge } from '@/components/ui';
import { type Locale } from '@/lib/kb/locale';
import { CATEGORY_WORDS } from '@/lib/portal/status-words';

/**
 * A ticket's state as the customer should see it.
 *
 * Falls back to a plain word for the status *category* (`CATEGORY_WORDS`)
 * whenever the configured status has no customer label or is marked
 * internal-only — `listTickets` and `getTicket` send null for both, and never
 * the status's name. Agents name statuses for themselves — "Waiting on ops",
 * "Escalated tier 2" — and those names are a running commentary on our own
 * operations that no customer asked for. The category still tells them the one
 * thing they want to know: is anyone still on this.
 */
const TONES = {
  open: 'open',
  pending: 'pending',
  resolved: 'resolved',
  closed: 'closed',
} as const;

export function StatusBadge({
  locale,
  label,
  category,
}: {
  locale: Locale;
  label: string | null;
  category: keyof typeof TONES;
}) {
  return <Badge tone={TONES[category]}>{label ?? CATEGORY_WORDS[category][locale]}</Badge>;
}
