'use client';

import { Badge, Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteInternalRecipient, saveInternalRecipient } from '../settings-actions';
import type { InternalRecipient } from '@/lib/side-conversations/queries';

function Fields({ recipient }: { recipient?: InternalRecipient }) {
  return (
    <>
      {recipient ? <input type="hidden" name="id" value={recipient.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Name"
          hint="What an agent will look for in the picker under pressure. Use the name the team says out loud."
        >
          <Input name="name" defaultValue={recipient?.name} required placeholder="Finance" />
        </Field>

        <Field
          label="Email address"
          hint="Usually a shared mailbox or a forwarding list, so whoever is on shift can answer."
        >
          <Input
            name="email"
            type="email"
            defaultValue={recipient?.email}
            required
            placeholder="finance@shipblu.com"
          />
        </Field>

        <Field label="Kind" hint="Only groups the picker. It changes nothing about the send.">
          <Select name="kind" defaultValue={recipient?.kind ?? 'team'}>
            <option value="team">Internal team</option>
            <option value="vendor">Vendor</option>
          </Select>
        </Field>
      </div>

      <Field
        label="Notes"
        hint="When to use this one rather than another. Agents see it nowhere else."
      >
        <Textarea
          name="description"
          rows={2}
          defaultValue={recipient?.description ?? ''}
          placeholder="Everything held at or dispatched from Downtown. Ask them, not Ops, about a specific parcel."
        />
      </Field>

      <Toggle
        name="isActive"
        label="Available in the picker"
        hint="Turn off to retire a recipient. Existing side conversations keep it and keep working."
        defaultChecked={recipient?.isActive ?? true}
      />
    </>
  );
}

export function NewRecipient() {
  return (
    <Disclosure label="New recipient">
      {(close) => (
        <EditorForm action={saveInternalRecipient} submitLabel="Add recipient" onSaved={close}>
          <Fields />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function RecipientEditor({ recipient }: { recipient: InternalRecipient }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{recipient.name}</h2>
        <Badge>{recipient.kind}</Badge>
        {recipient.isActive ? null : <Badge tone="closed">retired</Badge>}
        <span className="text-xs text-[var(--muted-foreground)]">{recipient.email}</span>
        <div className="ms-auto">
          <DangerAction action={deleteInternalRecipient} id={recipient.id} />
        </div>
      </div>

      <EditorForm action={saveInternalRecipient} submitLabel="Save">
        <Fields recipient={recipient} />
      </EditorForm>
    </div>
  );
}
