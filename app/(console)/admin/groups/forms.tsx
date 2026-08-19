'use client';

import { useState } from 'react';
import { Field, Input } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteGroup, saveGroup } from '../settings-actions';

type Group = { id: string; name: string; description: string | null };

export function NewGroup() {
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
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function GroupEditor({ group, deleteOnly = false }: { group: Group; deleteOnly?: boolean }) {
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
    </EditorForm>
  );
}
