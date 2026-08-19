'use client';

import { useState } from 'react';
import { Badge, Field, Input, Select, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteStatus, saveStatus } from '../settings-actions';

type Status = {
  id: string;
  name: string;
  category: 'open' | 'pending' | 'resolved' | 'closed';
  stopsSlaClock: boolean;
  visibleToCustomer: boolean;
  customerLabel: string | null;
  position: number;
  isDefault: boolean;
  isSystem: boolean;
};

function Fields({ status }: { status?: Status }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            name="name"
            defaultValue={status?.name}
            required
            placeholder="Waiting on courier"
          />
        </Field>
        <Field
          label="Category"
          hint="Reporting and SLA group every status by this, so pick the one that matches what the ticket really is."
        >
          <Select name="category" defaultValue={status?.category ?? 'open'}>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </Select>
        </Field>
        <Field label="Position" hint="Lower sorts first in the console.">
          <Input name="position" type="number" defaultValue={status?.position ?? 0} />
        </Field>
        <Field label="Label for customers" hint="Leave blank to reuse the name.">
          <Input name="customerLabel" defaultValue={status?.customerLabel ?? ''} />
        </Field>
      </div>

      <Toggle
        name="stopsSlaClock"
        label="Pause the SLA clock in this status"
        hint="For statuses where you are waiting on someone else. Time spent here is added back to the due date when the ticket moves on."
        defaultChecked={status?.stopsSlaClock ?? false}
      />
      <Toggle
        name="visibleToCustomer"
        label="Show this status to customers"
        defaultChecked={status?.visibleToCustomer ?? true}
      />
      <Toggle
        name="isDefault"
        label="Default for this category"
        hint="New tickets land in the default open status; replies resolve into the default resolved one."
        defaultChecked={status?.isDefault ?? false}
      />
    </>
  );
}

export function NewStatus() {
  return (
    <Disclosure label="New status">
      {(close) => (
        <EditorForm action={saveStatus} submitLabel="Create status" onSaved={close}>
          <Fields />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function StatusEditor({
  status,
  deleteOnly = false,
}: {
  status: Status;
  deleteOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (deleteOnly) {
    if (status.isSystem) {
      return <span className="text-xs text-[var(--muted-foreground)]">built in</span>;
    }
    return <DangerAction action={deleteStatus} id={status.id} />;
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-start hover:underline">
        <span className="font-medium">{status.name}</span>
        {status.isDefault ? (
          <span className="ms-2">
            <Badge tone="brand">default</Badge>
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <EditorForm action={saveStatus} submitLabel="Save" onSaved={() => setEditing(false)}>
      <input type="hidden" name="id" value={status.id} />
      <Fields status={status} />
    </EditorForm>
  );
}
