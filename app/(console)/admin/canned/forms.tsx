'use client';

import { useState } from 'react';
import { Field, Input, Textarea } from '@/components/ui';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteCannedResponse, saveCannedResponse } from '../settings-actions';

type Canned = {
  id: string;
  title: string;
  folder: string | null;
  bodyTextAr: string;
  bodyTextEn: string;
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
      {/*
        Both languages on one screen rather than two responses to keep in step.
        They are the same reply, and an agent picking one in the composer is
        picking a language, not a different piece of boilerplate.

        Neither is `required`: the team writes the Arabic first and the English
        when they get to it, and a form that refused the half they had would be
        answered by pasting the Arabic into both boxes. The action requires one
        of the two, which is the real rule.
      */}
      <Field
        label="Arabic"
        hint="Plain text. Email sends it as paragraphs; WhatsApp, Messenger and Instagram send it as written."
      >
        <Textarea name="bodyTextAr" rows={6} dir="rtl" defaultValue={response?.bodyTextAr} />
      </Field>
      <Field label="English" hint="Leave either language blank and the picker offers the other.">
        <Textarea name="bodyTextEn" rows={6} defaultValue={response?.bodyTextEn} />
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
          {response.bodyTextAr || response.bodyTextEn}
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
