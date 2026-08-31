'use client';

import { useState } from 'react';
import { Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { Collapsible, DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteField, saveField } from '../settings-actions';

type TicketField = {
  id: string;
  key: string;
  label: string;
  labelAr: string | null;
  labelEn: string | null;
  type: string;
  options: { value: string; label: string; labelAr?: string }[];
  validation: {
    pattern?: string;
    patternMessageAr?: string;
    patternMessageEn?: string;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
  } | null;
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
        <Field
          label="Name"
          hint="What the console calls it."
          explain="Used everywhere the field is administered — this list, the ticket sidebar, and the menu an automation or SLA condition picks from. It is also what a customer sees in a language nobody has translated it into, so it is worth being a real phrase rather than a code."
        >
          <Input name="label" defaultValue={field?.label} required placeholder="Order number" />
        </Field>

        {field ? (
          <Field label="Key" hint="Fixed — the stored answers and every rule are filed under it.">
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
          explain="Lower comes first everywhere the fields are listed: down the ticket sidebar in the console, down the portal’s new-ticket form, and in the list an automation or SLA condition picks from. Ties fall back to the label, alphabetically."
        >
          <Input name="position" type="number" defaultValue={field?.position ?? 0} />
        </Field>
      </div>

      <Field
        label="Wording customers see"
        as="group"
        hint="Leave a language blank and it falls back to the name above, so a field nobody has translated still reads as a phrase rather than as a key."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            name="labelAr"
            dir="rtl"
            lang="ar"
            aria-label="Customer wording, Arabic"
            defaultValue={field?.labelAr ?? ''}
            placeholder="رقم الطلب"
          />
          <Input
            name="labelEn"
            aria-label="Customer wording, English"
            defaultValue={field?.labelEn ?? ''}
            placeholder="Order number"
          />
        </div>
      </Field>

      <Field
        label="Choices"
        hint="One per line, for dropdowns and multi-selects: value|Label|Arabic. The value is what a rule compares against and never changes; the two labels are what a person reads."
      >
        <Textarea
          name="options"
          rows={3}
          defaultValue={(field?.options ?? [])
            .map((option) => {
              const parts = [option.value];
              if (option.label !== option.value || option.labelAr) parts.push(option.label);
              if (option.labelAr) parts.push(option.labelAr);
              return parts.join('|');
            })
            .join('\n')}
          placeholder={'cod|Cash on delivery|الدفع عند الاستلام\nprepaid|Prepaid|مدفوع مسبقًا'}
        />
      </Field>

      <Collapsible label="Rules about the answer">
        <>
          <Field
            label="Pattern the answer must match"
            hint="A regular expression. Anchored automatically, so a partial match is not a pass."
            explain={
              <>
                For the fields where a wrong-looking answer is worse than no answer — a tracking
                number, a national ID. <code>SB[0-9]&#123;8&#125;</code> accepts SB12345678 and
                refuses everything else, including a message that merely contains one. Checked in
                the browser and again on the server; only the second is true.
              </>
            }
          >
            <Input
              name="pattern"
              defaultValue={field?.validation?.pattern ?? ''}
              placeholder="SB[0-9]{8}"
            />
          </Field>

          <Field
            label="What to say when it does not match"
            as="group"
            hint="The one validation message a customer actually reads. Blank falls back to a generic sentence in their language."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                name="patternMessageAr"
                dir="rtl"
                lang="ar"
                aria-label="Pattern message, Arabic"
                defaultValue={field?.validation?.patternMessageAr ?? ''}
              />
              <Input
                name="patternMessageEn"
                aria-label="Pattern message, English"
                defaultValue={field?.validation?.patternMessageEn ?? ''}
              />
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Smallest number">
              <Input
                name="min"
                type="number"
                step="any"
                defaultValue={field?.validation?.min ?? ''}
              />
            </Field>
            <Field label="Largest number">
              <Input
                name="max"
                type="number"
                step="any"
                defaultValue={field?.validation?.max ?? ''}
              />
            </Field>
            <Field label="Shortest text">
              <Input
                name="minLength"
                type="number"
                defaultValue={field?.validation?.minLength ?? ''}
              />
            </Field>
            <Field label="Longest text">
              <Input
                name="maxLength"
                type="number"
                defaultValue={field?.validation?.maxLength ?? ''}
              />
            </Field>
          </div>
        </>
      </Collapsible>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          name="requiredOnCreate"
          label="Required when a ticket is created"
          hint="The default a form inherits — a form can still mark this field required or optional for itself."
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
          hint="Needs “visible to customers” as well. The pair is what lets a customer answer this field; a form still has to place the question for it to be asked."
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
