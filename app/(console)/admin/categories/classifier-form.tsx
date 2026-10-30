'use client';

import Link from 'next/link';
import { RelativeTime } from '@/components/relative-time';
import { ErrorText, Field, Input, Notice, Select, SuccessText } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';
import {
  CATEGORY_AI_MODES,
  ROUTING_WINDOW_MINUTES,
  type CategoryAiMode,
} from '@/lib/category-ai/modes';
import { ago } from '@/lib/format';
import type { ActionState } from '@/lib/http/action-state';
import { saveClassifierSettings } from './actions';

/**
 * The switch for Jev's category classifier, its threshold and the routing
 * window, in one form.
 *
 * Imports only `lib/category-ai/modes.ts` from the classifier, which touches no
 * database, so the schema stays out of the browser (`client-db`). The fields
 * are uncontrolled, so the form submits through `useActionForm`, whose
 * refusal leaves a mistyped threshold where the admin can correct it.
 */

const INITIAL: ActionState = { error: null };

const MODE_LABELS: Record<CategoryAiMode, string> = {
  off: 'Off — Jev is asked nothing',
  shadow: 'Shadow — Jev is asked and its answers recorded; no ticket changes',
  apply: 'Apply — a confident answer files the ticket',
};

export function ClassifierForm({
  mode,
  minProbability,
  routingWindowMinutes,
  keyConfigured,
  changedAt,
  changedBy,
}: {
  mode: CategoryAiMode;
  minProbability: number;
  routingWindowMinutes: number;
  /** Whether this environment holds `TYPESAFE_API_KEY` — a yes or no, never the value. */
  keyConfigured: boolean;
  changedAt: Date | null;
  changedBy: string | null;
}) {
  const { state, form } = useActionForm(saveClassifierSettings, INITIAL);

  return (
    <form
      {...form}
      className="mb-6 flex flex-col gap-3 rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)"
    >
      <div className="flex items-center gap-1 text-sm font-semibold">
        Jev files new tickets
        <InfoTip label="Jev files new tickets">
          TypeSafe&rsquo;s Jev model reads a customer&rsquo;s message and chooses which of the
          categories below it belongs to &mdash; or none, for a greeting or a message too short to
          tell. It is asked about the first five customer messages on a ticket nobody has answered
          yet, and the first answer that names a category at or above the threshold settles the
          ticket; &ldquo;none of these&rdquo; never does, however sure. It never changes a category
          a person, a rule or a form chose, and a category it chose is changed like any other.
        </InfoTip>
      </div>

      <p className="text-xs text-(--color-text-secondary)">
        Each question sends TypeSafe the customer&rsquo;s message, their earlier messages on the
        ticket, its channel, and every active category&rsquo;s English label and description. Never
        an internal note, never the team&rsquo;s replies.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Mode">
          <Select name="mode" defaultValue={mode}>
            {CATEGORY_AI_MODES.map((value) => (
              <option key={value} value={value}>
                {MODE_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Threshold"
          hint="The share of Jev's answer below which it never files a ticket, above 0 and up to 1. Every answer is recorded with the threshold it met."
        >
          <Input
            name="minProbability"
            type="number"
            inputMode="decimal"
            min={0.01}
            max={1}
            step={0.01}
            required
            defaultValue={minProbability}
          />
        </Field>
        <Field
          label="Routing window"
          hint="Minutes a new ticket on a channel that routes by category waits for its category before it is routed without one. Copied onto each ticket as it arrives, so a change never moves a window already running."
        >
          <Input
            name="routingWindowMinutes"
            type="number"
            inputMode="numeric"
            min={ROUTING_WINDOW_MINUTES.min}
            max={ROUTING_WINDOW_MINUTES.max}
            step={1}
            required
            defaultValue={routingWindowMinutes}
          />
        </Field>
      </div>

      {!keyConfigured ? (
        <Notice tone="warning" icon>
          This environment has no <code>TYPESAFE_API_KEY</code>, so Jev is asked nothing here
          whatever the mode says.
        </Notice>
      ) : null}

      <p className="text-xs text-(--color-text-secondary)">
        {changedAt ? (
          <RelativeTime at={changedAt}>
            {(relative) => `Last changed ${ago(relative)}${changedBy ? ` by ${changedBy}` : ''}.`}
          </RelativeTime>
        ) : (
          'Never switched on.'
        )}{' '}
        <Link href="/admin/ai" className="underline">
          All AI features
        </Link>
      </p>

      <ErrorText>{state.error}</ErrorText>
      {state.ok ? <SuccessText>Saved.</SuccessText> : null}

      <SubmitButton className="self-start" idle="Save" busy="Saving…" />
    </form>
  );
}
