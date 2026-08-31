'use client';

import { useState } from 'react';
import { Badge, Field, Input, Select, Textarea, Toggle } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteTicketForm, saveTicketForm } from '../settings-actions';
import { ElementsBuilder, type FieldChoice } from './elements-builder';

type Choice = { value: string; label: string };

export type TicketForm = {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  elements: unknown;
  requiresSignIn: boolean;
  showOnHelpCentre: boolean;
  showInConsole: boolean;
  defaultGroupId: string | null;
  defaultPriority: string | null;
  defaultType: string | null;
  defaultTags: string[];
  subjectTemplate: string | null;
  confirmationAr: string;
  confirmationEn: string;
  position: number;
  isActive: boolean;
};

function Fields({
  form,
  groups,
  fields,
  nextPosition,
}: {
  form?: TicketForm;
  groups: Choice[];
  fields: FieldChoice[];
  nextPosition?: number;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name, Arabic" hint="Either language is enough.">
          <Input
            name="nameAr"
            dir="rtl"
            lang="ar"
            defaultValue={form?.nameAr}
            placeholder="بلاغ عن شحنة تالفة"
          />
        </Field>
        <Field label="Name, English">
          <Input name="nameEn" defaultValue={form?.nameEn} placeholder="Report a damaged parcel" />
        </Field>
      </div>

      <Field
        label="Web address"
        hint="Leave blank to build one from the name."
        explain={
          <>
            The last part of the form&rsquo;s link on the help centre —{' '}
            <code>/ar/forms/your-slug</code>. Changing it breaks any link already sent to a
            customer, and any automation written against <code>form.slug</code>, so it is worth
            settling before the form is published.
          </>
        }
      >
        <Input name="slug" defaultValue={form?.slug} placeholder="damaged-parcel" />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Intro, Arabic" hint="Shown above the questions.">
          <Textarea
            name="descriptionAr"
            rows={2}
            dir="rtl"
            lang="ar"
            defaultValue={form?.descriptionAr}
          />
        </Field>
        <Field label="Intro, English">
          <Textarea name="descriptionEn" rows={2} defaultValue={form?.descriptionEn} />
        </Field>
      </div>

      <Field
        label="Questions"
        as="group"
        explain={
          <>
            The form, in the order it is asked. A <b>custom field</b> stores its answer under
            <code> custom.the_key</code>, where a rule or a report can read it. A{' '}
            <b>built-in question</b> is one every ticket already has — the subject, the message,
            attachments — so it lands in its own column rather than in a field. Headings and notes
            collect nothing and exist to break up a long form.
            <br />
            <br />A field marked <b>agents only</b> is one whose own settings say a customer may not
            read or write it. Placing it here does not override that — the help centre leaves it
            out, and only an agent opening a ticket is asked it.
          </>
        }
      >
        <ElementsBuilder name="elements" fields={fields} initial={form?.elements ?? []} />
      </Field>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          name="requiresSignIn"
          label="Only signed-in customers can submit"
          hint="Off means anybody can — the form then has to ask for an email address, and the ticket is marked as coming from somebody who did not sign in."
          defaultChecked={form?.requiresSignIn ?? true}
        />
        <Toggle
          name="isActive"
          label="Active"
          hint="Inactive takes it off the help centre without touching the tickets it opened."
          defaultChecked={form?.isActive ?? true}
        />
        <Toggle
          name="showOnHelpCentre"
          label="Offer it on the help centre"
          defaultChecked={form?.showOnHelpCentre ?? true}
        />
        <Toggle
          name="showInConsole"
          label="Offer it to agents"
          hint="For a ticket an agent opens on a customer's behalf."
          defaultChecked={form?.showInConsole ?? true}
        />
      </div>

      <Field
        label="Subject line"
        hint="Leave blank to use what the customer typed, or the form's name."
        explain={
          <>
            Built from the answers, so the inbox reads as a list rather than as forty copies of the
            same title. Write a field&rsquo;s key in double braces —{' '}
            <code>Damaged parcel &mdash; &#123;&#123;tracking_number&#125;&#125;</code> — and{' '}
            <code>&#123;&#123;subject&#125;&#125;</code> for what the customer typed. A placeholder
            whose answer is missing takes its separator with it, so nothing ends in a dangling dash.
            When this is set it wins, even over a subject the customer wrote.
          </>
        }
      >
        <Input
          name="subjectTemplate"
          defaultValue={form?.subjectTemplate ?? ''}
          placeholder="Damaged parcel — {{tracking_number}}"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Send it to"
          explain="Applied as the ticket is created. An on-create automation still runs afterwards and still wins — this is the default, not the last word."
        >
          <Select name="defaultGroupId" defaultValue={form?.defaultGroupId ?? ''}>
            <option value="">No group</option>
            {groups.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Priority">
          <Select name="defaultPriority" defaultValue={form?.defaultPriority ?? ''}>
            <option value="">Normal (medium)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
        </Field>

        <Field label="Ticket type" hint="Free text, the same column the console shows.">
          <Input
            name="defaultType"
            defaultValue={form?.defaultType ?? ''}
            placeholder="Complaint"
          />
        </Field>

        <Field label="Tags" hint="Comma separated.">
          <Input
            name="defaultTags"
            defaultValue={(form?.defaultTags ?? []).join(', ')}
            placeholder="damaged, needs-photo"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Thank-you message, Arabic" hint="Shown after it is submitted.">
          <Textarea
            name="confirmationAr"
            rows={2}
            dir="rtl"
            lang="ar"
            defaultValue={form?.confirmationAr}
          />
        </Field>
        <Field label="Thank-you message, English">
          <Textarea name="confirmationEn" rows={2} defaultValue={form?.confirmationEn} />
        </Field>
      </div>

      <Field label="Order" hint="Lower comes first in the list of forms.">
        <Input
          name="position"
          type="number"
          defaultValue={form?.position ?? nextPosition ?? 1}
          className="sm:w-32"
        />
      </Field>
    </>
  );
}

export function NewForm(props: { groups: Choice[]; fields: FieldChoice[]; nextPosition: number }) {
  return (
    <Disclosure label="New form">
      {(close) => (
        <EditorForm action={saveTicketForm} submitLabel="Create form" onSaved={close}>
          <Fields {...props} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function FormEditor({
  form,
  groups,
  fields,
  questionCount,
}: {
  form: TicketForm;
  groups: Choice[];
  fields: FieldChoice[];
  questionCount: number;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex flex-wrap items-center gap-2 text-start hover:underline"
        >
          <span className="text-[var(--muted-foreground)]">{form.position}.</span>
          <span className="font-medium">{form.nameEn || form.nameAr || form.slug}</span>
        </button>

        <code className="text-xs text-[var(--muted-foreground)]">/{form.slug}</code>
        <span className="text-xs text-[var(--muted-foreground)]">
          {questionCount} question{questionCount === 1 ? '' : 's'}
        </span>
        {!form.isActive ? <Badge tone="neutral">inactive</Badge> : null}
        {!form.requiresSignIn ? <Badge tone="warning">open to anybody</Badge> : null}
        {!form.showOnHelpCentre ? <Badge tone="neutral">agents only</Badge> : null}

        <span className="ms-auto">
          <DangerAction action={deleteTicketForm} id={form.id} />
        </span>
      </div>
    );
  }

  return (
    <EditorForm action={saveTicketForm} submitLabel="Save" onSaved={() => setEditing(false)}>
      <input type="hidden" name="id" value={form.id} />
      <Fields form={form} groups={groups} fields={fields} />
    </EditorForm>
  );
}
