'use client';

import { CANNED_LOCALES, type CannedLocale } from '@/lib/tickets/canned';

/**
 * The two buttons, each written in its own script.
 *
 * "العربية" is what an Arabic reply looks like, which is the thing the agent is
 * choosing; "AR" beside "EN" is two Latin abbreviations that have to be decoded
 * first.
 */
const LABELS: Record<CannedLocale, string> = { ar: 'العربية', en: 'English' };

/**
 * Which language the next insertion is in — the canned reply picker's, and the
 * knowledge panel's article search.
 *
 * Two buttons rather than a `<select>` because there are exactly two and the
 * whole point is that switching costs one tap. The pressed state, not a radio:
 * it changes what the next pick inserts and nothing about the reply being
 * submitted, so it posts no field and must not travel with the form.
 *
 * Drawn as a segmented control, the chosen half in the selected tint rather
 * than a solid blue fill — a solid blue pill beside the Send button reads as a
 * second button to press.
 */
export function LocaleToggle({
  value,
  onChange,
  label,
}: {
  value: CannedLocale;
  onChange: (next: CannedLocale) => void;
  /** What the pair chooses the language of, for a screen reader. */
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 overflow-hidden rounded-md border border-(--color-border-default)"
    >
      {CANNED_LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`px-2 py-1.5 text-xs transition-colors sm:py-1 ${
            value === option
              ? 'bg-(--color-background-selected) font-medium text-(--color-text-brand)'
              : 'text-(--color-text-secondary) hover:bg-(--color-background-hover)'
          }`}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
