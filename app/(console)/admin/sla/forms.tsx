'use client';

import { useState } from 'react';
import { Badge, Button, Field, Input, Select, Toggle } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import type { SlaTargets } from '@/db/schema/config';
import { ConditionBuilder, type FieldOption } from '../condition-builder';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteSlaPolicy, saveSlaPolicy } from '../settings-actions';

type Choice = { value: string; label: string };

type Policy = {
  id: string;
  name: string;
  description: string | null;
  conditions: unknown;
  targets: SlaTargets;
  escalations: { firstResponse?: { afterMins: number; agentIds: string[] } };
  hoursSource: 'group' | 'schedule' | 'round_the_clock';
  businessHoursId: string | null;
  position: number;
  isDefault: boolean;
  isActive: boolean;
};

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/** Says which calendar a policy counts against, in the words the setting uses. */
function describeHours(policy: Policy, scheduleName: string | null): string {
  if (policy.hoursSource === 'round_the_clock') return 'Round the clock';
  if (policy.hoursSource === 'schedule') {
    return scheduleName
      ? `Working hours: ${scheduleName}`
      : 'Working hours: a schedule that no longer exists — falls back to the default';
  }
  return "Working hours: the ticket group's, or the default schedule";
}

/**
 * Targets are entered in minutes, which is what the engine stores. Hours would
 * read more naturally for resolution and worse for first response, and a mixed
 * unit is how a four-hour target gets entered as four minutes.
 */
function TargetGrid({ targets }: { targets?: SlaTargets }) {
  return (
    <div className="app-scroll overflow-x-auto">
      <table className="w-full min-w-[30rem] text-sm">
        <thead>
          <tr>
            <th className="pb-1 text-start text-xs font-medium text-[var(--muted-foreground)]">
              Priority
            </th>
            <th className="pb-1 text-start text-xs font-medium text-[var(--muted-foreground)]">
              First response{' '}
              <InfoTip label="First response">
                From the ticket arriving to the first reply sent by an agent. Automated replies —
                including a canned response sent by a rule and the out-of-hours acknowledgement — do
                not stop this clock.
              </InfoTip>
            </th>
            <th className="pb-1 text-start text-xs font-medium text-[var(--muted-foreground)]">
              Next response{' '}
              <InfoTip label="Next response">
                Every reply after the first. It starts only once the ticket has been answered once,
                restarts each time the customer writes again, and clears the moment an agent
                replies. Left blank it does not go away — it falls back to the first-response target
                on the same row.
              </InfoTip>
            </th>
            <th className="pb-1 text-start text-xs font-medium text-[var(--muted-foreground)]">
              Resolution{' '}
              <InfoTip label="Resolution">
                From arrival to the ticket reaching a resolved status. Time in a status that pauses
                the clock does not count — that is what the pause is for.
              </InfoTip>
            </th>
          </tr>
        </thead>
        <tbody>
          {PRIORITIES.map((priority) => (
            <tr key={priority}>
              <td className="py-1 pe-3 capitalize">{priority}</td>
              {(['first', 'next', 'resolution'] as const).map((column) => {
                const key =
                  column === 'first'
                    ? 'firstResponseMins'
                    : column === 'next'
                      ? 'nextResponseMins'
                      : 'resolutionMins';
                return (
                  <td key={column} className="py-1 pe-3">
                    <input
                      type="number"
                      min={0}
                      name={`${priority}_${column}`}
                      defaultValue={targets?.[priority]?.[key] ?? ''}
                      placeholder="—"
                      className="w-24 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">
        Minutes. Leave blank for no commitment on that target — blank means nothing is owed, not
        that it is due immediately. Next response is the exception: blank there inherits the
        first-response target rather than dropping the commitment.
      </p>
    </div>
  );
}

function Fields({
  policy,
  schedules,
  agents,
  fields,
  position,
}: {
  policy?: Policy;
  schedules: Choice[];
  agents: Choice[];
  fields: FieldOption[];
  position?: number;
}) {
  const escalationAgents = policy?.escalations?.firstResponse?.agentIds ?? [];

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input name="name" defaultValue={policy?.name} required placeholder="Urgent tickets" />
        </Field>
        <Field label="Order" hint="Lower runs first. The first match wins.">
          <Input name="position" type="number" defaultValue={policy?.position ?? position ?? 1} />
        </Field>
      </div>

      <Field label="Description">
        <Input name="description" defaultValue={policy?.description ?? ''} />
      </Field>

      <Field
        as="group"
        label="Applies to"
        hint="Leave empty to apply to every ticket, which is what a default policy usually wants."
      >
        <ConditionBuilder name="conditions" fields={fields} initial={policy?.conditions ?? {}} />
      </Field>

      <Field as="group" label="Targets">
        <TargetGrid targets={policy?.targets} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Count against"
          hint="The ticket's group by default, so a team with its own operating days and holidays gets them without a policy of its own."
        >
          <Select name="hoursSource" defaultValue={policy?.hoursSource ?? 'group'}>
            <option value="group">The ticket group&apos;s business hours</option>
            <option value="schedule">One specific schedule</option>
            <option value="round_the_clock">Round the clock</option>
          </Select>
        </Field>

        <Field
          label="Schedule"
          hint="Used only when counting against one specific schedule, whatever group the ticket is in."
        >
          <Select name="businessHoursId" defaultValue={policy?.businessHoursId ?? ''}>
            <option value="">—</option>
            {schedules.map((schedule) => (
              <option key={schedule.value} value={schedule.value}>
                {schedule.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Escalate after (minutes past the target)">
          <Input
            name="escalateAfter"
            type="number"
            min={0}
            defaultValue={policy?.escalations?.firstResponse?.afterMins ?? 0}
          />
        </Field>
      </div>

      <Field
        as="group"
        label="Escalate to"
        hint="These agents are added as watchers on a breached ticket and the reason is recorded on its timeline. There is no notification channel yet, so this is a watchlist rather than an alert."
      >
        <select
          name="escalationAgentIds"
          multiple
          defaultValue={escalationAgents}
          size={Math.min(5, Math.max(3, agents.length))}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-sm"
        >
          {agents.map((agent) => (
            <option key={agent.value} value={agent.value}>
              {agent.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          name="isDefault"
          label="Default policy"
          hint="Applies when no other policy matches, even if its own conditions do not."
          defaultChecked={policy?.isDefault ?? false}
        />
        <Toggle name="isActive" label="Active" defaultChecked={policy?.isActive ?? true} />
      </div>
    </>
  );
}

export function NewPolicy({
  schedules,
  agents,
  fields,
  nextPosition,
}: {
  schedules: Choice[];
  agents: Choice[];
  fields: FieldOption[];
  nextPosition: number;
}) {
  return (
    <Disclosure label="New policy">
      {(close) => (
        <EditorForm action={saveSlaPolicy} submitLabel="Create policy" onSaved={close}>
          <Fields schedules={schedules} agents={agents} fields={fields} position={nextPosition} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function PolicyEditor({
  policy,
  schedules,
  agents,
  fields,
  scheduleName,
}: {
  policy: Policy;
  schedules: Choice[];
  agents: Choice[];
  fields: FieldOption[];
  scheduleName: string | null;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditorForm
        action={saveSlaPolicy}
        submitLabel="Save policy"
        onSaved={() => setEditing(false)}
      >
        <input type="hidden" name="id" value={policy.id} />
        <Fields policy={policy} schedules={schedules} agents={agents} fields={fields} />
      </EditorForm>
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span className="text-[var(--muted-foreground)]">{policy.position}.</span>
          {policy.name}
          {policy.isDefault ? <Badge tone="brand">default</Badge> : null}
          {!policy.isActive ? <Badge tone="neutral">inactive</Badge> : null}
        </h2>

        {policy.description ? (
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{policy.description}</p>
        ) : null}

        <p className="mt-2 text-xs text-[var(--muted-foreground)]">
          {describeHours(policy, scheduleName)}
        </p>

        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          {PRIORITIES.map((priority) => {
            const target = policy.targets?.[priority];
            if (!target?.firstResponseMins && !target?.resolutionMins) return null;
            return (
              <li key={priority}>
                <span className="capitalize">{priority}</span>:{' '}
                <span className="text-[var(--muted-foreground)]">
                  {target.firstResponseMins
                    ? `${target.firstResponseMins}m reply`
                    : 'no reply target'}
                  {target.resolutionMins ? ` · ${target.resolutionMins}m resolve` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <DangerAction
          action={deleteSlaPolicy}
          id={policy.id}
          confirmLabel="Delete (or deactivate if in use)"
        />
      </div>
    </div>
  );
}
