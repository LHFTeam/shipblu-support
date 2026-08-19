'use client';

import { useState } from 'react';
import { Field, Input, Select } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteGroup, saveGroup } from '../settings-actions';

type Group = {
  id: string;
  name: string;
  description: string | null;
  businessHoursId: string | null;
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

export function NewGroup({ schedules }: { schedules: Choice[] }) {
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
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function GroupEditor({
  group,
  schedules,
  deleteOnly = false,
}: {
  group: Group;
  schedules: Choice[];
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
    </EditorForm>
  );
}
