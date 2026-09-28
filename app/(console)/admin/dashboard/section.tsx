import type { ReactNode } from 'react';

export type Point = { day: string; label: string; created: number; resolved: number };

export function Section({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions ? <div className="ms-auto order-last sm:order-none">{actions}</div> : null}
        {hint ? (
          <p className="w-full max-w-3xl text-xs text-[var(--muted-foreground)]">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The table twin every chart on this page carries.
 *
 * Collapsed rather than absent: a chart's values must be reachable without
 * reading a colour or hovering a bar, but a dashboard that prints every number
 * twice by default is unreadable.
 */
export function TableView({
  summary,
  head,
  rows,
}: {
  summary: string;
  head: string[];
  rows: string[][];
}) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
        {summary}
      </summary>
      <div className="app-scroll mt-2 max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[var(--surface)]">
            <tr className="border-b border-[var(--border)]">
              {head.map((cell) => (
                <th
                  key={cell}
                  className="px-2 py-1 text-start font-medium text-[var(--muted-foreground)]"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]} className="border-b border-[var(--border)] last:border-0">
                {row.map((cell, index) => (
                  <td key={index} className="px-2 py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Green until it slips, amber while it is recoverable, red once it is not. */
export function slaTone(value: number | null): 'good' | 'warning' | 'critical' {
  if (value === null || value >= 90) return 'good';
  return value >= 75 ? 'warning' : 'critical';
}
