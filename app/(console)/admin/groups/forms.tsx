'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, Cell, Field, Input, Row, Select, Table, Toggle } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
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
            hint="The most tickets on an open status auto-assignment gives one member at once. A ticket waiting on the customer does not count towards it. Blank means uncapped, and an agent's own cap overrides this."
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

const STRATEGY_LABELS: Record<Group['assignmentStrategy'], string> = {
  manual: 'Manual',
  round_robin: 'Round robin',
  load_balanced: 'Load balanced',
};

type GroupSummary = {
  group: Group;
  /** The group's own schedule, or null when it works the company one. */
  scheduleName: string | null;
  members: number;
  tickets: number;
};

/**
 * The list, and the editor for whichever row is open.
 *
 * The editor is deliberately *not* inside the row's first cell, which is where
 * every other settings screen puts it. A group's form is the longest one in the
 * admin — hours, four assignment settings, skills, escalation — and a table
 * column sizes itself to the other rows, so on a phone that form rendered into
 * about a hundred pixels of a horizontally scrolling table, with every select
 * and hint crushed into a vertical ribbon. Above the table it gets the page's
 * whole width at every viewport, and reads the same as the "New group" form it
 * shares its fields with.
 *
 * Which row is open lives here rather than in each row so that opening a second
 * group closes the first: two long forms stacked on one screen is how you save
 * the wrong one.
 */
export function GroupsTable({
  rows,
  schedules,
  agents,
  defaultScheduleName,
}: {
  rows: GroupSummary[];
  schedules: Choice[];
  agents: Choice[];
  defaultScheduleName: string | null;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = rows.find((row) => row.group.id === editingId)?.group ?? null;
  const editorRef = useRef<HTMLDivElement | null>(null);

  // The open form is above the table, so clicking the twentieth group would
  // otherwise change something off-screen and look like nothing happened.
  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [editing]);

  return (
    <>
      {editing ? (
        <div ref={editorRef} id="group-editor" className="mb-4">
          {/* Keyed so that opening a different group remounts the form rather
              than leaving the previous one's assignment state on screen. */}
          <Card key={editing.id} className="w-full border-brand-500/30">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-sm font-semibold">{editing.name}</h2>
              <button
                type="button"
                onClick={() => setEditingId(null)}
                className="shrink-0 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Cancel
              </button>
            </div>

            <EditorForm action={saveGroup} submitLabel="Save" onSaved={() => setEditingId(null)}>
              <input type="hidden" name="id" value={editing.id} />
              <Field label="Name">
                <Input name="name" defaultValue={editing.name} required />
              </Field>
              <Field label="Description" hint="Shown to admins only.">
                <Input
                  name="description"
                  defaultValue={editing.description ?? ''}
                  placeholder="Handles delivery and tracking questions"
                />
              </Field>
              <HoursField group={editing} schedules={schedules} />
              <AssignmentFields group={editing} agents={agents} />
            </EditorForm>
          </Card>
        </div>
      ) : null}

      <Table
        head={[
          'Group',
          'Assignment',
          'Business hours',
          <>
            Agents{' '}
            <InfoTip label="Agents">
              How many people are members of this group. Only members are ever assigned its tickets,
              so a routing group with none is a queue nothing comes out of.
            </InfoTip>
          </>,
          <>
            Tickets{' '}
            <InfoTip label="Tickets">
              Every ticket ever routed to this group, not the open backlog — an empty group with a
              count here is work that has nobody to go to. Channels the team only watches are left
              out.
            </InfoTip>
          </>,
          '',
        ]}
      >
        {rows.map(({ group, scheduleName, members, tickets }) => (
          <Row key={group.id}>
            <Cell>
              <button
                type="button"
                onClick={() => setEditingId(group.id)}
                aria-expanded={editingId === group.id}
                aria-controls="group-editor"
                className="text-start font-medium hover:underline"
              >
                {group.name}
              </button>
            </Cell>
            {/* On the list rather than only in the editor: a group set to manual
                while every other team routes is the kind of thing you want to
                notice by reading down a column. */}
            <Cell className="text-[var(--muted-foreground)]">
              {STRATEGY_LABELS[group.assignmentStrategy]}
              {group.assignmentStrategy !== 'manual' && group.matchSkills ? (
                <span className="block text-xs">by skill</span>
              ) : null}
            </Cell>
            <Cell className="text-[var(--muted-foreground)]">
              {scheduleName ?? (
                <span className="text-xs">
                  {defaultScheduleName ? `${defaultScheduleName} (default)` : '—'}
                </span>
              )}
            </Cell>
            <Cell className="text-[var(--muted-foreground)]">{members}</Cell>
            <Cell className="text-[var(--muted-foreground)]">{tickets}</Cell>
            <Cell className="text-end">
              <DangerAction action={deleteGroup} id={group.id} />
            </Cell>
          </Row>
        ))}
      </Table>
    </>
  );
}
