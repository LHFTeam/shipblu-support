'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Badge, Button, ErrorText } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { AdminState } from '../settings-shared';
import { startFreshdeskImport } from './actions';

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
        <p className="text-sm text-(--color-text-secondary)">
          Pulls categories, folders and articles from Freshdesk into the knowledge base, and records
          redirects so existing article links keep working.
        </p>
        <p className="mt-2 text-sm text-(--color-text-secondary)">
          Safe to run as many times as you like — it matches on each item&apos;s Freshdesk id, so a
          re-run updates what it imported before rather than duplicating it. Articles written here
          are never touched.
        </p>
      </section>

      {counts ? (
        <section className="rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)">
          <h2 className="mb-2 text-xs font-semibold text-(--color-text-secondary)">
            Knowledge base now holds
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['Categories', counts.categories],
              ['Folders', counts.folders],
              ['Articles', counts.articles],
              ['Redirects', counts.redirects],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs text-(--color-text-secondary)">{label}</dt>
                <dd className="text-lg font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          {/*
            Per language, because the totals above cannot show the failure this
            import is most prone to: Freshdesk serves translations only one item
            at a time, so a language can be missed entirely while everything
            else succeeds. An empty language reads as an alert, not a statistic.
          */}
          <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-(--color-border-subtle) pt-3 text-sm">
            {[
              ['English', counts.articles_en, counts.categories_en],
              ['Arabic', counts.articles_ar, counts.categories_ar],
            ].map(([label, articles, categories]) => (
              <div key={String(label)}>
                <dt className="text-xs text-(--color-text-secondary)">{label}</dt>
                <dd
                  className={
                    Number(articles) === 0
                      ? 'font-medium text-(--color-feedback-warning-fg)'
                      : 'font-medium'
                  }
                >
                  {articles} {Number(articles) === 1 ? 'article' : 'articles'}
                  <span className="text-(--color-text-secondary)">
                    {' '}
                    in {categories} {Number(categories) === 1 ? 'category' : 'categories'}
                  </span>
                </dd>
              </div>
            ))}
          </dl>

          {counts.articles_en === 0 || counts.articles_ar === 0 ? (
            <p className="mt-3 text-xs text-(--color-feedback-warning-fg)">
              One language has nothing in it. If Freshdesk does hold articles in it, the run log on
              the worker names which language codes were found and which were not.
            </p>
          ) : null}
        </section>
      ) : null}

      <section>
        <form action={action}>
          <StartButton />
        </form>
        <ErrorText>{state.error}</ErrorText>

        <p className="mt-2 text-xs text-(--color-text-tertiary)">
          Needs FRESHDESK_DOMAIN and FRESHDESK_API_KEY set on the{' '}
          <span className="font-medium">worker</span> service. Those credentials are not readable
          from here, so if they are missing the run below will say so.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-(--color-text-secondary)">Recent runs</h2>

        {runs.length === 0 ? (
          <p className="text-sm text-(--color-text-tertiary)">No imports have been run yet.</p>
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
                      finished {formatRelative(run.completedAt)}
                    </span>
                  ) : null}
                </div>

                {run.lastError ? (
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-md bg-(--color-feedback-danger-bg) p-2 text-xs text-(--color-feedback-danger-fg)">
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
  if (status === 'completed') return 'success' as const;
  if (status === 'dead' || status === 'failed') return 'danger' as const;
  if (status === 'processing') return 'info' as const;
  return 'neutral' as const;
}

/** 'dead' is queue vocabulary; an admin reading this page wants plain words. */
function labelFor(status: string): string {
  return (
    { completed: 'Succeeded', dead: 'Failed', processing: 'Running', pending: 'Queued' }[status] ??
    status.charAt(0).toUpperCase() + status.slice(1)
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
