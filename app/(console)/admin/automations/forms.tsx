'use client';

import { useState } from 'react';
import { Badge, Button, Field, Input, Select, Toggle } from '@/components/ui';
import { ActionBuilder, type Choice } from '../action-builder';
import { ConditionBuilder, type FieldOption } from '../condition-builder';
import { DangerAction, Disclosure, EditorForm } from '../forms-shared';
import { deleteAutomationRule, saveAutomationRule } from '../settings-actions';

type Rule = {
  id: string;
  name: string;
  trigger: 'on_create' | 'on_update' | 'time_based';
  conditions: unknown;
  actions: unknown;
  position: number;
  isActive: boolean;
  stopProcessing: boolean;
};

type BuilderProps = {
  agents: Choice[];
  groups: Choice[];
  cannedResponses: Choice[];
  fields: FieldOption[];
};

function Fields({ rule, agents, groups, cannedResponses, fields }: BuilderProps & { rule?: Rule }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-2">
          <Input
            name="name"
            defaultValue={rule?.name}
            required
            placeholder="Route COD questions to billing"
          />
        </Field>
        <Field label="Order" hint="Lower runs first.">
          <Input name="position" type="number" defaultValue={rule?.position ?? 1} />
        </Field>
      </div>

      <Field label="When">
        <Select name="trigger" defaultValue={rule?.trigger ?? 'on_create'}>
          <option value="on_create">A ticket is created</option>
          <option value="on_update">A ticket is updated</option>
          <option value="time_based">On a schedule, by elapsed time</option>
        </Select>
      </Field>

      <Field as="group" label="If" hint="Leave empty to act on every ticket the trigger fires for.">
        <ConditionBuilder name="conditions" fields={fields} initial={rule?.conditions ?? {}} />
      </Field>

      <Field as="group" label="Then">
        <ActionBuilder
          name="actions"
          agents={agents}
          groups={groups}
          cannedResponses={cannedResponses}
          initial={rule?.actions ?? []}
        />
      </Field>

      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle
          name="stopProcessing"
          label="Stop processing after this rule"
          hint="Later rules are skipped for that ticket. This is how you say “if it is spam, do that and nothing else”."
          defaultChecked={rule?.stopProcessing ?? false}
        />
        <Toggle name="isActive" label="Active" defaultChecked={rule?.isActive ?? true} />
      </div>
    </>
  );
}

export function NewRule(props: BuilderProps) {
  return (
    <Disclosure label="New rule">
      {(close) => (
        <EditorForm action={saveAutomationRule} submitLabel="Create rule" onSaved={close}>
          <Fields {...props} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

export function RuleEditor({
  rule,
  lastRun,
  ...props
}: BuilderProps & { rule: Rule; lastRun: string | null }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditorForm
        action={saveAutomationRule}
        submitLabel="Save rule"
        onSaved={() => setEditing(false)}
      >
        <input type="hidden" name="id" value={rule.id} />
        <Fields rule={rule} {...props} />
      </EditorForm>
    );
  }

  const actionCount = Array.isArray(rule.actions) ? rule.actions.length : 0;

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="text-[var(--muted-foreground)]">{rule.position}.</span>
          {rule.name}
          {!rule.isActive ? <Badge tone="neutral">off</Badge> : null}
          {rule.stopProcessing ? <Badge tone="warning">stops processing</Badge> : null}
        </h3>
        <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
          {actionCount} action{actionCount === 1 ? '' : 's'}
          {lastRun ? ` · last matched ${lastRun}` : ' · never matched yet'}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <DangerAction action={deleteAutomationRule} id={rule.id} />
      </div>
    </div>
  );
}
