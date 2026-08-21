'use client';

import { useState } from 'react';
import { Field, Input, Select, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteGroup, saveGroup } from '../settings-actions';

type Group = {
  id: string;
  name: string;
  description: string | null;
  businessHoursId: string | null;
  assignmentStrategy: 'manual' | 'round_robin' | 'load_balanced';
  matchSkills: boolean;
  skillTimeoutMins: number | null;
  defaultMaxOpenTickets: number | null;
  assignWithinHoursOnly: boolean;
  reclaimAfterMins: number | null;
  escalateToAgentId: string | null;
  escalateAfterMins: number | null;
};

type Choice = { value: string; label: string };

/**
 * The hours picker is the group's whole override: a schedule carries a timezone,
 * the operating days and its own holidays, so "this team works different days"
 * and "this team takes different holidays" are one choice rather than three
 * settings that can disagree.
 */
function HoursField({ group, schedules }: { group?: Group; schedules: Choice[] }) {
  return (
    <Field
      label="Business hours"
      hint="The team's own operating days, hours and holidays. Leave on the default and this group works the company schedule."
    >
      <Select name="businessHoursId" defaultValue={group?.businessHoursId ?? ''}>
        <option value="">Default schedule</option>
        {schedules.map((schedule) => (
          <option key={schedule.value} value={schedule.value}>
            {schedule.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}


/**
 * How this group hands work to people.
 *
 * The four options an admin expects to see — manual, round robin, load balanced,
 * skill-based — over three stored values plus a `matchSkills` flag. Skills are a
 * filter on the candidates, not a way of choosing between them, so making
 * "skill-based" its own strategy would force somebody turning skills on to
 * re-answer a question they had already answered. Here it reveals the
 * distribution choice instead of replacing it.
 */
function AssignmentFields({ group, agents }: { group?: Group; agents: Choice[] }) {
  const [strategy, setStrategy] = useState(group?.assignmentStrategy ?? 'manual');
  const [skills, setSkills] = useState(group?.matchSkills ?? false);

  const auto = strategy !== 'manual';

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[var(--border)] p-3">
      <p className="text-xs font-medium text-[var(--muted-foreground)]">Assignment</p>

      <Field
        label="How tickets reach an agent"
        hint="Only agents who are in this group, signed in and accepting tickets are ever chosen."
      >
        <Select
          name="assignmentStrategy"
          value={strategy}
          onChange={(event) =>
            setStrategy(event.target.value as 'manual' | 'round_robin' | 'load_balanced')
          }
        >
          <option value="manual">Manual — tickets wait in the queue</option>
          <option value="round_robin">Round robin — each agent in turn</option>
          <option value="load_balanced">Load balanced — whoever is holding least</option>
        </Select>
      </Field>

      {auto ? (
        <>
          {/* Written out rather than using <Toggle> because this one drives what
              else is on screen, and a checkbox whose state nothing reads cannot. */}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="matchSkills"
              checked={skills}
              onChange={(event) => setSkills(event.target.checked)}
              className="mt-0.5 size-4 accent-brand-600"
            />
            <span>
              <span className="font-medium">Match skills first</span>
              <span className="block text-xs text-[var(--muted-foreground)]">
                Only offer the ticket to agents holding every skill it matches, then distribute as
                above.
              </span>
            </span>
          </label>

          <Field
            label="Default ticket cap per agent"
            hint="Blank means uncapped. An agent's own cap overrides this."
          >
            <Input
              name="defaultMaxOpenTickets"
              type="number"
              min={0}
              defaultValue={group?.defaultMaxOpenTickets ?? ''}
              placeholder="No cap"
            />
          </Field>

          {skills ? (
            <Field
              label="Give up on skills after (minutes)"
              hint="A ticket nobody skilled has taken by then goes to anyone free. Blank means it waits indefinitely — worth setting, because a mistake in a skill's conditions is otherwise a ticket no human ever sees."
            >
              <Input
                name="skillTimeoutMins"
                type="number"
                min={0}
                defaultValue={group?.skillTimeoutMins ?? ''}
                placeholder="Never"
              />
            </Field>
          ) : null}

          <Toggle
            name="assignWithinHoursOnly"
            label="Only assign during this group's business hours"
            hint="Off, and a ticket arriving at 2am lands on whoever happens to be signed in."
            defaultChecked={group?.assignWithinHoursOnly ?? true}
          />

          <Field
            label="Take unanswered tickets back after (minutes offline)"
            hint="Blank means never. Only ever applies to a ticket the agent has not yet replied to — once they have answered, the thread stays theirs."
          >
            <Input
              name="reclaimAfterMins"
              type="number"
              min={1}
              defaultValue={group?.reclaimAfterMins ?? ''}
              placeholder="Never"
            />
          </Field>
        </>
      ) : null}

      <Field
        label="Escalate unassigned tickets to"
        hint="Adds them as a watcher on anything still unassigned after the wait below."
      >
        <Select name="escalateToAgentId" defaultValue={group?.escalateToAgentId ?? ''}>
          <option value="">Nobody</option>
          {agents.map((agent) => (
            <option key={agent.value} value={agent.value}>
              {agent.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Escalate after (minutes)" hint="Blank means never.">
        <Input
          name="escalateAfterMins"
          type="number"
          min={1}
          defaultValue={group?.escalateAfterMins ?? ''}
          placeholder="Never"
        />
      </Field>
    </div>
  );
}

export function NewGroup({ schedules, agents }: { schedules: Choice[]; agents: Choice[] }) {
  return (
    <Disclosure label="New group">
      {(close) => (
        <EditorForm action={saveGroup} submitLabel="Create group" onSaved={close}>
          <Field label="Name">
            <Input name="name" required placeholder="Shipping support" />
          </Field>
          <Field label="Description" hint="Shown to admins only.">
            <Input name="description" placeholder="Handles delivery and tracking questions" />
          </Field>
          <HoursField schedules={schedules} />
          <AssignmentFields agents={agents} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function GroupEditor({
  group,
  schedules,
  agents,
  deleteOnly = false,
}: {
  group: Group;
  schedules: Choice[];
  agents: Choice[];
  deleteOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (deleteOnly) return <DangerAction action={deleteGroup} id={group.id} />;

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-start hover:underline">
        <span className="font-medium">{group.name}</span>
        {group.description ? (
          <span className="block text-xs text-[var(--muted-foreground)]">{group.description}</span>
        ) : null}
      </button>
    );
  }

  return (
    <EditorForm action={saveGroup} submitLabel="Save" onSaved={() => setEditing(false)}>
      <input type="hidden" name="id" value={group.id} />
      <Input name="name" defaultValue={group.name} required />
      <Input name="description" defaultValue={group.description ?? ''} placeholder="Description" />
      <HoursField group={group} schedules={schedules} />
      <AssignmentFields group={group} agents={agents} />
    </EditorForm>
  );
}
