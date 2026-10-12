'use client';

import { useActionState } from 'react';
import { ErrorText } from '@/components/ui';
import type { AdminState } from '../settings-shared';
import { startLocationBackfill } from './actions';
import {
  BackfillRuns,
  StartBackfillButton,
  useRefreshWhileRunning,
  type BackfillRun,
} from './backfill-runs';

const INITIAL: AdminState = { error: null };

type Counts = {
  /** Messages whose stored payload mentions a location at all. */
  candidates: number;
  /** Of those, the ones now carrying a usable pin. */
  recovered: number;
};

export function LocationBackfillForm({
  runs,
  counts,
}: {
  runs: BackfillRun[];
  counts: Counts | null;
}) {
  const [state, action] = useActionState(startLocationBackfill, INITIAL);
  useRefreshWhileRunning(runs);

  const remaining = counts ? Math.max(0, counts.candidates - counts.recovered) : 0;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h1 className="mb-1 text-lg font-semibold">Shared location backfill</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Recovers the map pins customers shared before the console could read them. New messages
          keep their coordinates as they arrive; this is for everything that came before, where the
          pin only ever reached us as text.
        </p>
        <p className="mt-2 text-sm text-(--color-text-secondary)">
          Safe to run as many times as you like. It reads the original payload stored on each
          message, skips anything that already has a pin, and never removes one.
        </p>
      </section>

      {counts ? (
        <section className="rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)">
          <h2 className="mb-2 text-xs font-semibold text-(--color-text-secondary)">
            Shared locations
          </h2>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-(--color-text-secondary)">Messages with a pin</dt>
              <dd className="text-lg font-medium">{counts.candidates}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-text-secondary)">Readable on a map</dt>
              <dd className="text-lg font-medium">{counts.recovered}</dd>
            </div>
            <div>
              <dt className="text-xs text-(--color-text-secondary)">Still text only</dt>
              <dd
                className={
                  remaining > 0
                    ? 'text-lg font-medium text-(--color-feedback-warning-fg)'
                    : 'text-lg font-medium'
                }
              >
                {remaining}
              </dd>
            </div>
          </dl>

          {remaining > 0 ? (
            <p className="mt-3 text-xs text-(--color-feedback-warning-fg)">
              {remaining} message{remaining === 1 ? '' : 's'} still show the coordinates as text, so
              an agent has to copy them into a map by hand. Running this converts them.
            </p>
          ) : counts.candidates > 0 ? (
            <p className="mt-3 text-xs text-(--color-text-secondary)">
              Every shared location in the archive opens on a map.
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
          The run log on the worker breaks its counts down per channel. A channel where most
          candidates come back unreadable is the thing worth looking at — it means the stored
          payload on it is not shaped the way this expects.
        </p>
      </section>

      <BackfillRuns runs={runs} empty="No location backfills have been run yet." />
    </div>
  );
}
