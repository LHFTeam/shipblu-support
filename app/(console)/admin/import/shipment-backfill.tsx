'use client';

import { useActionState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Badge, Button, ErrorText } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import { startShipmentBackfill, type AdminState } from '../actions';

const INITIAL: AdminState = { error: null };

/** Named rather than Record<string, number>: every read below is required. */
type Counts = {
  shipments: number;
  accounts: number;
  links: number;
  links_detected: number;
  account_links: number;
  unsynced: number;
};

type Run = {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
};

export function ShipmentBackfillForm({ runs, counts }: { runs: Run[]; counts: Counts | null }) {
  const [state, action] = useActionState(startShipmentBackfill, INITIAL);
  const router = useRouter();

  const inFlight = runs.some((run) => run.status === 'pending' || run.status === 'processing');

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [inFlight, router]);

  const manual = counts ? counts.links - counts.links_detected : 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="mb-1 text-lg font-semibold">Shipment link backfill</h1>
        <p className="text-sm opacity-70">
          Reads every message already in the archive and links the tracking numbers and SBIDs it
          finds. New messages are linked as they arrive; this is for everything that came before —
          and for reaching history after the detection pattern is corrected.
        </p>
        <p className="mt-2 text-sm opacity-70">
          Safe to run as many times as you like. Every link it writes is keyed on the pair it joins,
          so a second run over the same messages creates nothing. It never removes a link.
        </p>
      </section>

      {counts ? (
        <section className="rounded-lg border border-[var(--border)] p-4">
          <h2 className="mb-2 text-xs font-medium opacity-60">Linked so far</h2>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['Shipments', counts.shipments],
              ['Shipping accounts', counts.accounts],
              ['Ticket links', counts.links],
              ['Account mentions', counts.account_links],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs opacity-60">{label}</dt>
                <dd className="text-lg font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          {/*
            Split by how each link came to exist. A total cannot tell "the
            detector is working" apart from "agents have been doing this by
            hand", and those call for opposite responses — the second means the
            pattern is wrong.
          */}
          <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-[var(--border)] pt-3 text-sm">
            <div>
              <dt className="text-xs opacity-60">Found automatically</dt>
              <dd className="font-medium">{counts.links_detected}</dd>
            </div>
            <div>
              <dt className="text-xs opacity-60">Linked by an agent</dt>
              <dd
                className={
                  manual > counts.links_detected ? 'font-medium text-amber-600' : 'font-medium'
                }
              >
                {manual}
              </dd>
            </div>
          </dl>

          {manual > counts.links_detected && counts.links > 0 ? (
            <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
              Agents are linking more shipments by hand than the detector finds, which usually means
              the tracking-number pattern does not match the real format. Set
              SHIPMENT_TRACKING_PATTERN on the web and worker services and run this again.
            </p>
          ) : null}

          {counts.unsynced === counts.shipments && counts.shipments > 0 ? (
            <p className="mt-3 text-xs opacity-60">
              Every shipment is still a stub — expected until something syncs them against the
              shipping platform, which nothing does yet.
            </p>
          ) : null}
        </section>
      ) : null}

      <section>
        <form action={action}>
          <StartButton />
        </form>
        <ErrorText>{state.error}</ErrorText>

        <p className="mt-2 text-xs opacity-50">
          The run log on the worker breaks its counts down per channel. A channel with plenty of
          messages and no matches at all is the thing worth looking at — it usually means the
          pattern does not fit how that channel writes them.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium opacity-70">Recent runs</h2>

        {runs.length === 0 ? (
          <p className="text-sm opacity-50">No backfills have been run yet.</p>
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
                  <pre className="mt-1.5 overflow-x-auto rounded bg-red-500/10 p-2 text-xs whitespace-pre-wrap text-red-700 dark:text-red-300">
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
      {pending ? 'Queuing…' : 'Run backfill now'}
    </Button>
  );
}
