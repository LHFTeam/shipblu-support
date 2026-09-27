'use client';

import { useState } from 'react';
import { Badge, Button, Field, Select, Textarea, Toggle } from '@/components/ui';
import { PLACEHOLDERS } from '@/lib/auto-response/resolve';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteAutoResponse, saveAutoResponse } from './actions';

type Group = { id: string; name: string };

type Rule = {
  id: string;
  groupId: string | null;
  channel: string | null;
  bodyAr: string;
  bodyEn: string;
  holidayBodyAr: string;
  holidayBodyEn: string;
  silent: boolean;
  isActive: boolean;
};

/**
 * `whatsapp_bot` is missing on purpose: those conversations belong to the
 * customer bot and nothing is ever sent into them. The list matches the one the
 * server action validates against — an option here that the action rejects is a
 * form that fails on save for no reason the admin can see.
 */
const CHANNELS: { value: string; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'webchat', label: 'Web chat' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'portal', label: 'Customer portal' },
];

function channelLabel(value: string | null): string {
  return CHANNELS.find((channel) => channel.value === value)?.label ?? 'Every channel';
}

const PLACEHOLDER_HELP = (
  <ul className="flex flex-col gap-1">
    {PLACEHOLDERS.map((placeholder) => (
      <li key={placeholder.token}>
        <code className="font-mono">{placeholder.token}</code> — {placeholder.describes}
      </li>
    ))}
  </ul>
);

function Fields({ rule, groups }: { rule?: Rule; groups: Group[] }) {
  // Controlled only so the bodies can be hidden when the rule sends nothing:
  // four empty textareas under a "send nothing" tick is four fields asking to be
  // filled in with something that will never be read.
  const [silent, setSilent] = useState(rule?.silent ?? false);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Group"
          explain="Which team’s tickets this covers — and whose calendar decides that the office is shut. Every group works the default schedule unless it has been put on its own."
        >
          <Select name="groupId" defaultValue={rule?.groupId ?? ''}>
            <option value="">Every group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Channel"
          explain="Scope the wording to one medium. An email can carry three paragraphs where a WhatsApp message should be two lines, which is the usual reason to add a second rule."
        >
          <Select name="channel" defaultValue={rule?.channel ?? ''}>
            <option value="">Every channel</option>
            {CHANNELS.map((channel) => (
              <option key={channel.value} value={channel.value}>
                {channel.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/*
        The checkbox stays uncontrolled — the form submits it — and this listens
        on the way past to hide the bodies underneath it. Four empty textareas
        under a ticked "send nothing" are four fields asking to be filled in with
        something nothing will ever read.
      */}
      <div
        onChange={(event) => {
          const target = event.target as HTMLInputElement;
          if (target.name === 'silent') setSilent(target.checked);
        }}
      >
        <Toggle
          name="silent"
          label="Send nothing for this scope"
          hint="Covers the group or channel and stays quiet — how you exempt web chat, where the widget already says the office is shut, without unpicking the company-wide message."
          defaultChecked={rule?.silent ?? false}
        />
      </div>

      {silent ? null : (
        <>
          <Field
            label="Out of hours"
            explain={
              <>
                <p className="mb-2">
                  Sent once when a customer writes in outside working hours, in the language on
                  their contact record. Filling in one language is enough — the other falls back to
                  it.
                </p>
                {PLACEHOLDER_HELP}
              </>
            }
            as="group"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Textarea
                name="bodyAr"
                dir="rtl"
                rows={4}
                defaultValue={rule?.bodyAr}
                aria-label="Out of hours, Arabic"
                placeholder="شكرًا لتواصلك. مكتبنا مغلق حاليًا وسنرد عليك {{next_opening}}."
              />
              <Textarea
                name="bodyEn"
                rows={4}
                defaultValue={rule?.bodyEn}
                aria-label="Out of hours, English"
                placeholder="Thanks for writing in. We’re closed right now and will reply on {{next_opening}}."
              />
            </div>
          </Field>

          <Field
            label="Holidays"
            hint="Optional. Left empty, a holiday gets the out-of-hours message above."
            explain={
              <>
                <p className="mb-2">
                  Sent instead on any day marked a holiday on the calendar this group works.{' '}
                  <code className="font-mono">{'{{holiday}}'}</code> becomes the name of that day,
                  so one message covers every holiday in the year rather than one per Eid.
                </p>
                {PLACEHOLDER_HELP}
              </>
            }
            as="group"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Textarea
                name="holidayBodyAr"
                dir="rtl"
                rows={4}
                defaultValue={rule?.holidayBodyAr}
                aria-label="Holidays, Arabic"
                placeholder="إجازة {{holiday}} — نعود إليك {{next_opening}}."
              />
              <Textarea
                name="holidayBodyEn"
                rows={4}
                defaultValue={rule?.holidayBodyEn}
                aria-label="Holidays, English"
                placeholder="We’re closed for {{holiday}} and will be back on {{next_opening}}."
              />
            </div>
          </Field>
        </>
      )}

      <Toggle
        name="isActive"
        label="Active"
        hint="Turned off, this rule stops matching and its tickets fall back to the next broadest one — not to silence."
        defaultChecked={rule?.isActive ?? true}
      />
    </>
  );
}

export function NewAutoResponse({ groups }: { groups: Group[] }) {
  return (
    <Disclosure label="New reply">
      {(close) => (
        <EditorForm action={saveAutoResponse} submitLabel="Create reply" onSaved={close}>
          <Fields groups={groups} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function AutoResponseEditor({ rule, groups }: { rule: Rule; groups: Group[] }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditorForm action={saveAutoResponse} submitLabel="Save" onSaved={() => setEditing(false)}>
        <input type="hidden" name="id" value={rule.id} />
        <Fields rule={rule} groups={groups} />
      </EditorForm>
    );
  }

  const group = groups.find((candidate) => candidate.id === rule.groupId);
  const preview = rule.bodyEn.trim() || rule.bodyAr.trim();
  const holiday = rule.holidayBodyEn.trim() || rule.holidayBodyAr.trim();

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {channelLabel(rule.channel)}
          <span className="font-normal text-[var(--muted-foreground)]">·</span>
          {group ? group.name : 'Every group'}
          {rule.silent ? <Badge>sends nothing</Badge> : null}
          {rule.isActive ? null : <Badge tone="warning">off</Badge>}
        </h2>

        {rule.silent ? (
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            Nothing is sent for this scope, and no broader rule applies to it.
          </p>
        ) : (
          <>
            <p className="mt-1 line-clamp-2 text-xs text-[var(--muted-foreground)]">{preview}</p>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              {holiday ? 'Holidays have their own message.' : 'Holidays get the same message.'}
            </p>
          </>
        )}
      </div>

      <div className="ms-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <DangerAction
          action={deleteAutoResponse}
          id={rule.id}
          label="Delete"
          confirmLabel="Delete reply"
        />
      </div>
    </div>
  );
}
