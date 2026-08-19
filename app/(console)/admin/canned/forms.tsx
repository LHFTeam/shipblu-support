'use client';

import { useState } from 'react';
import { Field, Input, Textarea } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteCannedResponse, saveCannedResponse } from '../settings-actions';

type Canned = {
  id: string;
  title: string;
  folder: string | null;
  bodyText: string;
};

function Fields({ response }: { response?: Canned }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          <Input
            name="title"
            defaultValue={response?.title}
            required
            placeholder="Delivery delay apology"
          />
        </Field>
        <Field label="Folder" hint="Optional grouping.">
          <Input name="folder" defaultValue={response?.folder ?? ''} placeholder="Delivery" />
        </Field>
      </div>
      <Field
        label="Message"
        hint="Plain text. Email sends it as paragraphs; WhatsApp, Messenger and Instagram send it as written."
      >
        <Textarea name="bodyText" rows={6} defaultValue={response?.bodyText} required />
      </Field>
    </>
  );
}

export function NewCanned() {
  return (
    <Disclosure label="New response">
      {(close) => (
        <EditorForm action={saveCannedResponse} submitLabel="Create response" onSaved={close}>
          <Fields />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function CannedEditor({
  response,
  deleteOnly = false,
}: {
  response: Canned;
  deleteOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);

  if (deleteOnly) return <DangerAction action={deleteCannedResponse} id={response.id} />;

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="text-start hover:underline">
        <span className="font-medium">{response.title}</span>
        <span className="block max-w-md truncate text-xs text-[var(--muted-foreground)]">
          {response.bodyText}
        </span>
      </button>
    );
  }

  return (
    <EditorForm action={saveCannedResponse} submitLabel="Save" onSaved={() => setEditing(false)}>
      <input type="hidden" name="id" value={response.id} />
      <Fields response={response} />
    </EditorForm>
  );
}
