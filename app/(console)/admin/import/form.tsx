'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Badge, Button, ErrorText } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import { startFreshdeskImport, type AdminState } from '../actions';

const INITIAL: AdminState = { error: null };

type Run = {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
};

export function ImportForm({
  runs,
  counts,
}: {
  runs: Run[];
  counts: Record<string, number> | null;
}) {
  const [state, action] = useActionState(startFreshdeskImport, INITIAL);
  const router = useRouter();

  // The job runs on the worker, so the page has to be re-read to see it move
  // from pending to completed. Polling only while something is in flight keeps
  // this from being a standing query against an idle page.
  const inFlight = runs.some((run) => run.status === 'pending' || run.status === 'processing');

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [inFlight, router]);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="mb-1 text-lg font-semibold">Freshdesk import</h1>
        <p className="text-sm opacity-70">
          Pulls categories, folders and articles from Freshdesk into the knowledge base, and records
          redirects so existing article links keep working.
        </p>
        <p className="mt-2 text-sm opacity-70">
          Safe to run as many times as you like — it matches on each item&apos;s Freshdesk id, so a
          re-run updates what it imported before rather than duplicating it. Articles written here
          are never touched.
        </p>
      </section>

      {counts ? (
        <section className="rounded-lg border border-[var(--border)] p-4">
          <h2 className="mb-2 text-xs font-medium opacity-60">Knowledge base now holds</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['Categories', counts.categories],
              ['Folders', counts.folders],
              ['Articles', counts.articles],
              ['Redirects', counts.redirects],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs opacity-60">{label}</dt>
                <dd className="text-lg font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section>
        <form action={action}>
          <StartButton />
        </form>
        <ErrorText>{state.error}</ErrorText>

        <p className="mt-2 text-xs opacity-50">
          Needs FRESHDESK_DOMAIN and FRESHDESK_API_KEY set on the{' '}
          <span className="font-medium">worker</span> service. Those credentials are not readable
          from here, so if they are missing the run below will say so.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium opacity-70">Recent runs</h2>

        {runs.length === 0 ? (
          <p className="text-sm opacity-50">No imports have been run yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
            {runs.map((run) => (
              <li key={run.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={toneFor(run.status)}>{labelFor(run.status)}</Badge>
                  <span className="opacity-60">{formatDateTime(run.createdAt)}</span>
                  {run.attempts > 1 ? (
                    <span className="text-xs opacity-50">attempt {run.attempts}</span>
                  ) : null}
                  {run.completedAt ? (
                    <span className="ms-auto text-xs opacity-50">
                      finished {formatRelative(run.completedAt)}
                    </span>
                  ) : null}
                </div>

                {run.lastError ? (
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
                    {run.lastError.split('\n').slice(0, 6).join('\n')}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function toneFor(status: string) {
  if (status === 'completed') return 'open' as const;
  if (status === 'dead' || status === 'failed') return 'danger' as const;
  if (status === 'processing') return 'warning' as const;
  return 'neutral' as const;
}

/** 'dead' is queue vocabulary; an admin reading this page wants plain words. */
function labelFor(status: string): string {
  return (
    { completed: 'succeeded', dead: 'failed', processing: 'running', pending: 'queued' }[status] ??
    status
  );
}

function StartButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Queuing…' : 'Run import now'}
    </Button>
  );
}
