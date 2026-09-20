import { Badge } from '@/components/ui';
import { type Locale } from '@/lib/kb/locale';

/**
 * A ticket's state as the customer should see it.
 *
 * Falls back to a plain word for the status *category* whenever the configured
 * status is marked internal-only. Agents name statuses for themselves — "Waiting
 * on ops", "Escalated tier 2" — and those names are a running commentary on our
 * own operations that no customer asked for. The category still tells them the
 * one thing they want to know: is anyone still on this.
 */
const CATEGORY_LABELS: Record<string, Record<Locale, string>> = {
  open: { en: 'Open', ar: 'مفتوحة' },
  pending: { en: 'In progress', ar: 'قيد المعالجة' },
  resolved: { en: 'Resolved', ar: 'تم الحل' },
  closed: { en: 'Closed', ar: 'مغلقة' },
};

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
  return (
    <Badge tone={TONES[category]}>{label ?? CATEGORY_LABELS[category]?.[locale] ?? category}</Badge>
  );
}
