'use client';

import { useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { RelativeTime } from '@/components/relative-time';
import { Badge, Button } from '@/components/ui';
import { ago, formatDateTime, sentenceCase } from '@/lib/format';

/**
 * The parts every backfill card shows the same way.
 *
 * Extracted when the second backfill landed rather than copied: a run list, a
 * status vocabulary and a submit button are one concern each, and two versions
 * of "what does status=dead say to the reader" would drift the first time one
 * was touched.
 */

export type BackfillRun = {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
};

export function isInFlight(runs: BackfillRun[]): boolean {
  return runs.some((run) => run.status === 'pending' || run.status === 'processing');
}

/**
 * Refreshes the page while a run is in flight.
 *
 * A backfill finishes on the worker, which has no way to push at this page, so
 * without this a completed run sits looking queued until somebody reloads.
 */
export function useRefreshWhileRunning(runs: BackfillRun[]): void {
  const router = useRouter();
  const inFlight = isInFlight(runs);

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [inFlight, router]);
}

export function BackfillRuns({ runs, empty }: { runs: BackfillRun[]; empty: string }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-(--color-text-secondary)">Recent runs</h2>

      {runs.length === 0 ? (
        <p className="text-sm text-(--color-text-tertiary)">{empty}</p>
      ) : (
        <ul className="divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
          {runs.map((run) => (
            <li key={run.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={toneFor(run.status)}>{labelFor(run.status)}</Badge>
                <span className="text-(--color-text-tertiary)">
                  {formatDateTime(run.createdAt)}
                </span>
                {run.attempts > 1 ? (
                  <span className="text-xs text-(--color-text-tertiary)">
                    attempt {run.attempts}
                  </span>
                ) : null}
                {run.completedAt ? (
                  <span className="ms-auto text-xs text-(--color-text-tertiary)">
                    <RelativeTime at={run.completedAt}>
                      {(relative) => `finished ${ago(relative)}`}
                    </RelativeTime>
                  </span>
                ) : null}
              </div>

              {run.lastError ? (
                <pre className="mt-1.5 overflow-x-auto rounded-md bg-(--color-feedback-danger-bg) p-2 text-xs whitespace-pre-wrap text-(--color-feedback-danger-fg)">
                  {run.lastError.split('\n').slice(0, 6).join('\n')}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function toneFor(status: string) {
  if (status === 'completed') return 'success' as const;
  if (status === 'dead' || status === 'failed') return 'danger' as const;
  if (status === 'processing') return 'info' as const;
  return 'neutral' as const;
}

/**
 * Job statuses in the words an admin uses.
 *
 * `dead` is the queue's word for "out of attempts" and reads like a database
 * state; the person looking at this page wants to know it failed.
 */
function labelFor(status: string): string {
  return (
    { completed: 'Succeeded', dead: 'Failed', processing: 'Running', pending: 'Queued' }[status] ??
    sentenceCase(status)
  );
}

export function StartBackfillButton({ label = 'Run backfill now' }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Queuing…' : label}
    </Button>
  );
}
