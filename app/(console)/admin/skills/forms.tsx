'use client';

import { useState } from 'react';
import { Badge, Button, Field, Input, Toggle } from '@/components/ui';
import { ConditionBuilder, type FieldOption } from '../condition-builder';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteSkill, saveSkill } from './actions';

type Skill = {
  id: string;
  name: string;
  description: string | null;
  conditions: unknown;
  position: number;
  isActive: boolean;
  agentIds: string[];
};

type Choice = { value: string; label: string };

type FormProps = { fields: FieldOption[]; agents: Choice[] };

function Fields({ skill, fields, agents }: FormProps & { skill?: Skill }) {
  const held = new Set(skill?.agentIds ?? []);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-2">
          <Input name="name" defaultValue={skill?.name} required placeholder="Arabic" />
        </Field>
        <Field label="Order" hint="Lower is evaluated first.">
          <Input name="position" type="number" defaultValue={skill?.position ?? 1} />
        </Field>
      </div>

      <Field label="Description" hint="Shown to admins only.">
        <Input
          name="description"
          defaultValue={skill?.description ?? ''}
          placeholder="Can hold a conversation in Arabic"
        />
      </Field>

      <Field
        as="group"
        label="A ticket needs this skill when"
        hint="Written in the same language as SLA policies and automation rules. Leave it empty and no ticket ever requires this skill — the skill exists, and nothing asks for it."
      >
        <ConditionBuilder name="conditions" fields={fields} initial={skill?.conditions ?? {}} />
      </Field>

      <Field
        as="group"
        label="Agents with this skill"
        hint="A ticket that needs it is only ever offered to these agents — and only while its group is set to match skills."
      >
        <div className="mt-1 flex flex-col gap-1">
          {agents.map((agent) => (
            <label key={agent.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="agentIds"
                value={agent.value}
                defaultChecked={held.has(agent.value)}
                className="size-4 accent-brand-600"
              />
              {agent.label}
            </label>
          ))}
          {agents.length === 0 ? (
            <p className="text-xs text-[var(--muted-foreground)]">No active agents yet.</p>
          ) : null}
        </div>
      </Field>

      <Toggle
        name="isActive"
        label="Active"
        hint="Switched off, no ticket requires it and the agents keep it."
        defaultChecked={skill?.isActive ?? true}
      />
    </>
  );
}

export function NewSkill(props: FormProps) {
  return (
    <Disclosure label="New skill">
      {(close) => (
        <EditorForm action={saveSkill} submitLabel="Create skill" onSaved={close}>
          <Fields {...props} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function SkillEditor({ skill, ...props }: FormProps & { skill: Skill }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditorForm action={saveSkill} submitLabel="Save skill" onSaved={() => setEditing(false)}>
        <input type="hidden" name="id" value={skill.id} />
        <Fields skill={skill} {...props} />
      </EditorForm>
    );
  }

  const holders = skill.agentIds.length;

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="text-[var(--muted-foreground)]">{skill.position}.</span>
          {skill.name}
          {!skill.isActive ? <Badge tone="neutral">off</Badge> : null}
          {/* The failure this screen exists to make visible. A skill nobody
              holds, matched by a group that routes on skills, is a ticket that
              waits for the skill timeout and then goes to anybody — or, with no
              timeout set, waits forever. */}
          {holders === 0 && skill.isActive ? <Badge tone="warning">nobody holds it</Badge> : null}
        </h3>
        <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
          {skill.description ? `${skill.description} · ` : ''}
          {holders} agent{holders === 1 ? '' : 's'}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <DangerAction action={deleteSkill} id={skill.id} />
      </div>
    </div>
  );
}
