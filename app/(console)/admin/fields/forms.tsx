'use client';

import { useState } from 'react';
import { Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteField, saveField } from '../settings-actions';

type TicketField = {
  id: string;
  key: string;
  label: string;
  type: string;
  options: { value: string; label: string }[];
  requiredOnCreate: boolean;
  requiredOnResolve: boolean;
  visibleToCustomer: boolean;
  editableByCustomer: boolean;
  position: number;
  isActive: boolean;
};

const TYPES = [
  'text',
  'paragraph',
  'number',
  'decimal',
  'checkbox',
  'dropdown',
  'multi_select',
  'date',
  'datetime',
];

function Fields({ field }: { field?: TicketField }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          <Input name="label" defaultValue={field?.label} required placeholder="Order number" />
        </Field>

        {field ? (
          <Field label="Key" hint="Fixed — stored rules refer to it.">
            <Input defaultValue={field.key} disabled />
          </Field>
        ) : (
          <Field
            label="Key"
            hint="Lowercase letters, numbers and underscores. Rules will refer to custom.your_key."
          >
            <Input name="key" required placeholder="order_number" pattern="[a-z][a-z0-9_]*" />
          </Field>
        )}

        <Field label="Type">
          <Select name="type" defaultValue={field?.type ?? 'text'}>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Position"
          explain="Lower comes first in the list of fields an automation or SLA condition can pick from, which is the only place these fields are read today — nothing renders them on a ticket yet."
        >
          <Input name="position" type="number" defaultValue={field?.position ?? 0} />
        </Field>
      </div>

      <Field
        label="Choices"
        hint="One per line, for dropdowns and multi-selects. Use value|Label to show something different from the stored value."
      >
        <Textarea
          name="options"
          rows={3}
          defaultValue={(field?.options ?? [])
            .map((option) =>
              option.value === option.label ? option.value : `${option.value}|${option.label}`,
            )
            .join('\n')}
          placeholder={'cod|Cash on delivery\nprepaid|Prepaid'}
        />
      </Field>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          name="requiredOnCreate"
          label="Required when a ticket is created"
          defaultChecked={field?.requiredOnCreate ?? false}
        />
        <Toggle
          name="requiredOnResolve"
          label="Required before resolving"
          hint="Useful for the fields a report depends on."
          defaultChecked={field?.requiredOnResolve ?? false}
        />
        <Toggle
          name="visibleToCustomer"
          label="Visible to customers"
          defaultChecked={field?.visibleToCustomer ?? false}
        />
        <Toggle
          name="editableByCustomer"
          label="Customers can edit it"
          defaultChecked={field?.editableByCustomer ?? false}
        />
      </div>
    </>
  );
}

export function NewField() {
  return (
    <Disclosure label="New field">
      {(close) => (
        <EditorForm action={saveField} submitLabel="Create field" onSaved={close}>
          <Fields />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function FieldEditor({
  field,
  deleteOnly = false,
}: {
  field: TicketField;
  deleteOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (deleteOnly) return <DangerAction action={deleteField} id={field.id} />;

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-start hover:underline">
        <span className="font-medium">{field.label}</span>
        {!field.isActive ? (
          <span className="ms-2 text-xs text-[var(--muted-foreground)]">inactive</span>
        ) : null}
      </button>
    );
  }

  return (
    <EditorForm action={saveField} submitLabel="Save" onSaved={() => setEditing(false)}>
      <input type="hidden" name="id" value={field.id} />
      <Fields field={field} />
    </EditorForm>
  );
}
