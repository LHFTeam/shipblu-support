'use client';

import { useActionState } from 'react';
import { ErrorText } from '@/components/ui';
import type { AdminState } from '../settings-shared';
import { startShipmentBackfill } from './actions';
import {
  BackfillRuns,
  StartBackfillButton,
  useRefreshWhileRunning,
  type BackfillRun,
} from './backfill-runs';

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

export function ShipmentBackfillForm({
  runs,
  counts,
}: {
  runs: BackfillRun[];
  counts: Counts | null;
}) {
  const [state, action] = useActionState(startShipmentBackfill, INITIAL);
  useRefreshWhileRunning(runs);

  const manual = counts ? counts.links - counts.links_detected : 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-1 text-lg font-semibold">Shipment link backfill</h2>
        <p className="text-sm text-(--color-text-secondary)">
          Reads every message already in the archive and links the tracking numbers and SBIDs it
          finds. New messages are linked as they arrive; this is for everything that came before —
          and for reaching history after the detection pattern is corrected.
        </p>
        <p className="mt-2 text-sm text-(--color-text-secondary)">
          Safe to run as many times as you like. Every link it writes is keyed on the pair it joins,
          so a second run over the same messages creates nothing. It never removes a link.
        </p>
      </section>

      {counts ? (
        <section className="rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)">
          <h3 className="mb-2 text-xs font-semibold text-(--color-text-secondary)">
            Linked so far
          </h3>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['Shipments', counts.shipments],
              ['Shipping accounts', counts.accounts],
              ['Ticket links', counts.links],
              ['Account mentions', counts.account_links],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs text-(--color-text-secondary)">{label}</dt>
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
          <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-(--color-border-subtle) pt-3 text-sm">
            <div>
              <dt className="text-xs text-(--color-text-secondary)">Found automatically</dt>
              <dd className="font-medium">{counts.links_detected}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-text-secondary)">Linked by an agent</dt>
              <dd
                className={
                  manual > counts.links_detected
                    ? 'font-medium text-(--color-feedback-warning-fg)'
                    : 'font-medium'
                }
              >
                {manual}
              </dd>
            </div>
          </dl>

          {manual > counts.links_detected && counts.links > 0 ? (
            <p className="mt-3 text-xs text-(--color-feedback-warning-fg)">
              Agents are linking more shipments by hand than the detector finds, which usually means
              the tracking-number pattern does not match the real format. Set
              SHIPMENT_TRACKING_PATTERN on the web and worker services and run this again.
            </p>
          ) : null}

          {counts.unsynced === counts.shipments && counts.shipments > 0 ? (
            <p className="mt-3 text-xs text-(--color-text-secondary)">
              Every shipment is still a stub — expected until something syncs them against the
              shipping platform, which nothing does yet.
            </p>
          ) : null}
        </section>
      ) : null}

      <section>
        <form action={action}>
          <StartBackfillButton />
        </form>
        <ErrorText>{state.error}</ErrorText>

        <p className="mt-2 text-xs text-(--color-text-tertiary)">
          The run log on the worker breaks its counts down per channel. A channel with plenty of
          messages and no matches at all is the thing worth looking at — it usually means the
          pattern does not fit how that channel writes them.
        </p>
      </section>

      <BackfillRuns runs={runs} empty="No backfills have been run yet." />
    </div>
  );
}
