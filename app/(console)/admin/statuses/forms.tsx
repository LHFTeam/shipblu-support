'use client';

import { useState } from 'react';
import { Badge, Field, Input, Select, Toggle } from '@/components/ui';
import { sentenceCase } from '@/lib/format';
import { categoryWord } from '@/lib/portal/status-words';
import { STATUS_CATEGORIES } from '@/lib/tickets/vocabulary';
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

/**
 * The English words a customer reads for a status with no label to show, taken
 * from the list the portal draws them from, so the hint cannot name a word the
 * portal does not. A word that is not its category's name says which category
 * it stands for, by the name the Category select gives it: the select says
 * "Pending", and the portal says "In progress".
 */
const CATEGORY_WORD_LIST = (() => {
  const words = STATUS_CATEGORIES.map((category) => {
    const word = categoryWord(category, 'en');
    return word.toLowerCase() === category ? word : `${word} (for ${sentenceCase(category)})`;
  });
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
})();

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
          {/* From the vocabulary, with the name the hint below calls each
              category by, so the two cannot name different ones. */}
          <Select name="category" defaultValue={status?.category ?? 'open'}>
            {STATUS_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {sentenceCase(category)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Position" hint="Lower sorts first in the console.">
          <Input name="position" type="number" defaultValue={status?.position ?? 0} />
        </Field>
        {/* This used to say a blank label reuses the name, which is the
            opposite of what happens: the portal never sends a customer the
            status's name, and a blank label falls back to the category's word
            (`CATEGORY_WORDS`) — so the built-in Pending reads "In progress",
            not "Pending". */}
        <Field
          label="Label for customers"
          hint={`If it is blank, customers see a plain word for the category in their own language instead. In English those are ${CATEGORY_WORD_LIST}. The name above is never shown to them.`}
          explain="What the customer portal shows beside their ticket while it is in this status, and only while “Show this status to customers” is on. A label is shown as written to Arabic and English readers alike, so blank is usually the better answer on a help centre read in both: each reader then gets the category’s word in their own language."
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
        hint="When it is off, customers see the category word in place of the label above, so with no label set it changes nothing they see. Their ticket stays in the portal either way."
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
