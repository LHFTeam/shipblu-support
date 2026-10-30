'use client';

import { useState } from 'react';
import { Badge, Field, Input, Select, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteStatus, saveStatus } from './actions';

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
        {/* This used to say a blank label reuses the name, which is the
            opposite of what happens: `listTickets` never sends a customer the
            status's name, and a blank label falls back to the category's word
            in `portal/status.tsx` — so the built-in Pending reads "In
            progress", not "Pending". */}
        <Field
          label="Label for customers"
          hint="Blank, customers see a plain word for the category in their own language instead: Open, In progress, Resolved or Closed. The name above is never shown to them."
          explain="What the customer portal shows beside their ticket while it is in this status. It is one text for Arabic and English readers alike, so write it in the language your customers read. It is shown only while “Show this status to customers” is on."
        >
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
        hint="Off, customers see the category word in place of the label above. Their ticket stays in the portal either way."
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
      return <span className="text-xs text-(--color-text-secondary)">built in</span>;
    }
    return <DangerAction action={deleteStatus} id={status.id} />;
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-start hover:underline">
        <span className="font-medium">{status.name}</span>
        {status.isDefault ? (
          <span className="ms-2">
            <Badge tone="brand">Default</Badge>
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
