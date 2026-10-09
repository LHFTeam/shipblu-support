'use client';

import { useState } from 'react';
import { ErrorText, Input, Label, Select } from '@/components/ui';
import { renderTemplatePreview, templateShape } from '@/lib/whatsapp/templates';
import { sendTemplateReply } from '../../reply-actions';
import type { TemplateOption } from './types';
import { INITIAL, LOST_SEND } from './form-state';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm, type FormHandlers } from '@/components/use-action-form';

/**
 * Template send.
 *
 * The variable inputs are generated from the components synced from Meta, and
 * the preview substitutes them live — outside the 24-hour window this is the
 * only way an agent can see what the customer will actually receive, and a
 * wrong parameter count comes back from Meta as an error code explaining
 * nothing.
 */
export function TemplateForm({
  conversationId,
  templates,
  onSent,
}: {
  conversationId: string;
  templates: TemplateOption[];
  onSent?: () => void;
}) {
  const { state, key, form } = useActionForm(sendTemplateReply, INITIAL, {
    lost: LOST_SEND,
    onSuccess: onSent,
  });

  if (templates.length === 0) {
    return (
      <p className="text-sm opacity-60">
        No approved templates are synced yet. They appear here within an hour of being approved in
        Meta Business Manager.
      </p>
    );
  }

  return (
    <TemplateDraft
      key={key}
      conversationId={conversationId}
      templates={templates}
      error={state.error}
      form={form}
    />
  );
}

/**
 * The form itself, keyed on the last send so a template that went out clears:
 * the choice and every value, which live here rather than above the key
 * (`docs/PROJECT-STATE.md` §6.58). Left filled in, the composer stays open on a
 * desktop and a second press sends the same paid template to the customer
 * again. React's reset used to move the select to the first template after a
 * send, which cleared nothing — the values stayed — and left the next send
 * pairing template one with template two's values.
 */
function TemplateDraft({
  conversationId,
  templates,
  error,
  form,
}: {
  conversationId: string;
  templates: TemplateOption[];
  error: string | null;
  form: FormHandlers;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});

  const template = templates.find((t) => t.id === templateId);
  const shape = template ? templateShape(template.components) : null;

  const bodyValues = Array.from(
    { length: shape?.bodyVariableCount ?? 0 },
    (_, index) => values[`body_${index + 1}`] ?? '',
  );

  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="conversationId" value={conversationId} />

      <div>
        <Label htmlFor="templateId">Template</Label>
        <Select
          id="templateId"
          name="templateId"
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            // Values are positional, so carrying them across to a different
            // template would put the wrong text in the wrong slot.
            setValues({});
          }}
        >
          {templates.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name} ({option.language})
            </option>
          ))}
        </Select>
      </div>

      {shape && shape.headerVariableCount > 0 ? (
        <VariableInputs
          prefix="header"
          count={shape.headerVariableCount}
          label="Header value"
          values={values}
          onChange={setValues}
        />
      ) : null}

      {shape && shape.bodyVariableCount > 0 ? (
        <VariableInputs
          prefix="body"
          count={shape.bodyVariableCount}
          label="Value"
          values={values}
          onChange={setValues}
        />
      ) : null}

      {shape?.bodyText ? (
        <div className="rounded-md bg-[var(--muted)] p-2.5 text-sm">
          <p className="mb-1 text-xs font-medium opacity-60">Preview</p>
          <p className="whitespace-pre-wrap">{renderTemplatePreview(shape.bodyText, bodyValues)}</p>
          {shape.footerText ? (
            <p className="mt-1.5 text-xs opacity-50">{shape.footerText}</p>
          ) : null}
        </div>
      ) : null}

      <ErrorText>{error}</ErrorText>

      <SubmitButton className="self-end" idle="Send template" busy="Sending…" />
    </form>
  );
}

function VariableInputs({
  prefix,
  count,
  label,
  values,
  onChange,
}: {
  prefix: string;
  count: number;
  label: string;
  values: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, index) => {
        const key = `${prefix}_${index + 1}`;
        return (
          <div key={key}>
            <Label htmlFor={key}>{`${label} {{${index + 1}}}`}</Label>
            <Input
              id={key}
              name={key}
              value={values[key] ?? ''}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              required
            />
          </div>
        );
      })}
    </div>
  );
}
