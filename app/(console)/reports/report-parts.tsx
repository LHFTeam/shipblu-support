import type { ReactNode } from 'react';
import { Notice } from '@/components/ui';

/**
 * What the reports draw alike, kept in one place so a change reaches them all
 * — the rule for when a rate is printed as a percentage above all, which two
 * pages carried word for word and would have drifted apart on the first edit.
 */

/** A section of a report: its title, one line on how to read it, and the figure. */
export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-semibold text-(--color-text-secondary)">{title}</h2>
      <p className="mb-2 max-w-3xl text-xs text-(--color-text-tertiary)">{hint}</p>
      {children}
    </section>
  );
}

/** An empty section said in words: an empty table reads as a page not finished. */
export function Quiet({ children }: { children: ReactNode }) {
  return (
    <Notice tone="neutral" className="max-w-2xl">
      {children}
    </Notice>
  );
}

/**
 * A rate, or the two counts it is made of when there are too few for a
 * percentage to mean anything. Nothing at all is a dash, not "0%".
 */
export function rate(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  if (denominator < 10) return `${numerator} of ${denominator}`;
  return `${Math.round((100 * numerator) / denominator)}%`;
}
