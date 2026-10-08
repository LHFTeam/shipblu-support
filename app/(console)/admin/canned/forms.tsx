'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ErrorText, Field, Input, SuccessText, Textarea, Toggle } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';
import type { ActionState } from '@/lib/http/action-state';
import { formatRelative } from '@/lib/format';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteCannedResponse, saveCannedResponse, saveCannedSuggestionSettings } from './actions';

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

const SWITCH_INITIAL: ActionState = { error: null };

/**
 * Whether the reply box suggests one of these, and what that sends where.
 *
 * Above the list it draws from, because the question an admin brings here —
 * "why did the composer offer that?" — is answered by the list, and the switch
 * should be beside the answer. The explanation is on screen rather than behind
 * an ⓘ: turning this on sends customer conversations to a third party, and that
 * belongs in front of the person deciding, not one tap away from them.
 */
export function SuggestionSwitchForm({
  enabled,
  keyConfigured,
  changedAt,
  changedBy,
}: {
  enabled: boolean;
  /** Whether this environment holds `TYPESAFE_API_KEY` — a yes or no, never the value. */
  keyConfigured: boolean;
  changedAt: Date | null;
  changedBy: string | null;
}) {
  const { state, form } = useActionForm(saveCannedSuggestionSettings, SWITCH_INITIAL);

  return (
    <form
      {...form}
      className="mb-6 flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      <div className="flex items-center gap-1 text-sm font-semibold">
        Suggest a response in the reply box
        <InfoTip label="Suggest a response in the reply box">
          When an agent clicks into an empty reply box, TypeSafe&rsquo;s Jev model reads the
          conversation and picks the one response below that fits it best &mdash; or none. It is
          shown as grey text in the box. <b>Tab</b> (or <b>Use</b> on a phone) puts it in, to edit
          or send; <b>Esc</b> waves it away. Jev only chooses; the text is always the stored
          response, and nothing reaches a customer until the agent presses Send.
        </InfoTip>
      </div>

      <p className="text-xs text-[var(--muted-foreground)]">
        Each suggestion sends TypeSafe the ticket&rsquo;s last ten messages, the customer&rsquo;s
        and the team&rsquo;s (never internal notes), and the title and text of every response that
        agent can see. It asks once per new message, not on every click.
      </p>

      <Toggle name="enabled" label="On for every agent who can reply" defaultChecked={enabled} />

      {!keyConfigured ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          This environment has no <code>TYPESAFE_API_KEY</code>, so nothing is suggested here
          whatever the switch says.
        </p>
      ) : null}

      <p className="text-xs text-[var(--muted-foreground)]">
        {changedAt
          ? `Last changed ${formatRelative(changedAt)}${changedBy ? ` by ${changedBy}` : ''}. `
          : 'Never switched on. '}
        <Link href="/reports/canned-suggestions" className="underline">
          How the suggestions are doing
        </Link>
      </p>

      <ErrorText>{state.error}</ErrorText>
      {state.ok ? <SuccessText>Saved.</SuccessText> : null}

      <SubmitButton className="self-start" idle="Save" busy="Saving…" />
    </form>
  );
}
