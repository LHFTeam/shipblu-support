'use client';

import { useState } from 'react';
import { ErrorText, Input, Select, Textarea } from '@/components/ui';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { formatForInput, selectedValues, type TicketFieldDef } from '@/lib/tickets/custom-fields';
import { updateTicket } from '../../ticket-actions';
import { useFieldAction } from './use-field-action';

/**
 * A labelled block in the ticket sidebar.
 *
 * Named apart from `Field` in `components/ui.tsx`: under that name it shadowed
 * the shared one inside the ticket page, so importing the shared `Field` there
 * would have silently rendered this one.
 */
export function SidebarField({
  label,
  hint,
  as = 'block',
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /**
   * `group` for a set of controls one label cannot belong to — the checkboxes
   * of a multi-select. Assistive technology reads the label once for the set
   * rather than leaving each box unnamed.
   */
  as?: 'block' | 'group';
  children: React.ReactNode;
}) {
  return (
    <div {...(as === 'group' ? { role: 'group', 'aria-label': label } : {})}>
      <p className="mb-1 flex items-center gap-1 text-xs font-medium text-(--color-text-secondary)">
        {label}
      </p>
      {children}
      {hint ? <p className="mt-1 text-xs text-(--color-text-secondary)">{hint}</p> : null}
    </div>
  );
}

/**
 * What a details-column control's save refused, under the control.
 *
 * The inline `ErrorText` rather than the banner: these sit in a 312px column
 * under a 34px select, and a filled box per control would outweigh the control
 * it is about.
 */
export function FieldError({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p className="mt-1">
      <ErrorText inline>{children}</ErrorText>
    </p>
  );
}

/**
 * Saves on change with no explicit save button, matching Freshdesk.
 * `updateTicket` revalidates the ticket before it succeeds, so the re-rendered
 * page comes back with its answer and the timeline already holds the audit
 * entry it wrote (§6.89).
 */
export function FieldSelect({
  conversationId,
  field,
  label,
  value,
  options,
}: {
  conversationId: string;
  field: string;
  /**
   * The control's accessible name. `SidebarField`'s label is a paragraph, not a
   * `<label>`, so without this the select is announced as an unnamed combobox.
   */
  label: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  const { pending: saving, error, run } = useFieldAction(updateTicket);

  async function save(next: string) {
    await run({ conversationId, field, value: next });
  }

  return (
    <>
      <Select
        value={value}
        disabled={saving}
        aria-label={label}
        onChange={(e) => save(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <FieldError>{error}</FieldError>
    </>
  );
}

export function TagField({ conversationId, tags }: { conversationId: string; tags: string[] }) {
  const [value, setValue] = useState(tags.join(', '));
  // No re-read on a refusal, like the other fields; a success's page comes back
  // with the action's answer. The one refusal a tag save can meet is "Ticket
  // not found", and the page's own read fails on the same conditions —
  // re-reading on it would swap the page for a 404 before the line below could
  // be read. It used to be dropped, so a save that failed on
  // blur looked exactly like one that worked.
  const { pending: saving, error, run } = useFieldAction(updateTicket);

  async function save() {
    if (value === tags.join(', ')) return;
    await run({ conversationId, field: 'tags', value });
  }

  return (
    <>
      <Input
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        placeholder="comma, separated"
        aria-label="Tags"
      />
      <FieldError>{error}</FieldError>
    </>
  );
}

/**
 * The admin-defined ticket fields.
 *
 * These are the first controls in the console ever to write
 * `conversations.custom_fields`. Until this existed an admin could define a
 * field, an automation could be written against `custom.<key>`, and the column
 * stayed `{}` on every ticket — so the rule matched nothing and nothing said so.
 *
 * One control per field rather than a single JSON box: the type is what decides
 * whether a stored 12 is a number a rule can order or a string it cannot, and a
 * free-text box would put that decision on whoever is typing.
 */
export function CustomFields({
  conversation,
  fields,
}: {
  conversation: ConversationDetail;
  fields: TicketFieldDef[];
}) {
  if (fields.length === 0) return null;

  return (
    <>
      {fields.map((field) => (
        <SidebarField
          key={field.key}
          label={field.label}
          as={field.type === 'multi_select' ? 'group' : 'block'}
          hint={field.requiredOnResolve ? 'Needed before this ticket can be resolved.' : null}
        >
          <CustomFieldControl
            conversationId={conversation.id}
            field={field}
            value={conversation.customFields[field.key]}
          />
        </SidebarField>
      ))}
    </>
  );
}

function CustomFieldControl({
  conversationId,
  field,
  value,
}: {
  conversationId: string;
  field: TicketFieldDef;
  value: unknown;
}) {
  const { pending: saving, error, run } = useFieldAction(updateTicket);
  const [draft, setDraft] = useState(() => formatForInput(field, value));

  async function save(next: string | string[]) {
    await run({ conversationId, field: `custom:${field.key}`, value: next });
  }

  const control = () => {
    switch (field.type) {
      case 'checkbox':
        return (
          <input
            type="checkbox"
            checked={value === true}
            disabled={saving}
            onChange={(e) => save(e.target.checked ? 'on' : '')}
            aria-label={field.label}
            className="size-4 accent-(--color-control-accent)"
          />
        );

      case 'dropdown':
        return (
          <Select
            value={String(value ?? '')}
            disabled={saving}
            aria-label={field.label}
            onChange={(e) => save(e.target.value)}
          >
            <option value="">—</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        );

      case 'multi_select': {
        const chosen = selectedValues(value);
        return (
          <div className="flex flex-col gap-1">
            {field.options.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.includes(option.value)}
                  disabled={saving}
                  onChange={(e) =>
                    save(
                      e.target.checked
                        ? [...chosen, option.value]
                        : chosen.filter((entry) => entry !== option.value),
                    )
                  }
                  className="size-4 shrink-0 accent-(--color-control-accent)"
                />
                {option.label}
              </label>
            ))}
            {field.options.length === 0 ? (
              <span className="text-xs text-(--color-text-tertiary)">No options defined.</span>
            ) : null}
          </div>
        );
      }

      case 'paragraph':
        return (
          <Textarea
            rows={3}
            dir="auto"
            value={draft}
            disabled={saving}
            aria-label={field.label}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== formatForInput(field, value) && save(draft)}
          />
        );

      // Date and time controls commit on change: they have no meaningful
      // intermediate state to protect, and a picker that saved on blur would
      // lose the choice if the agent clicked straight onto another field.
      case 'date':
      case 'datetime':
        return (
          <Input
            type={field.type === 'date' ? 'date' : 'datetime-local'}
            value={draft}
            disabled={saving}
            aria-label={field.label}
            onChange={(e) => {
              setDraft(e.target.value);
              void save(e.target.value);
            }}
          />
        );

      default:
        return (
          <Input
            type={field.type === 'number' || field.type === 'decimal' ? 'number' : 'text'}
            step={field.type === 'decimal' ? 'any' : field.type === 'number' ? '1' : undefined}
            value={draft}
            disabled={saving}
            aria-label={field.label}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== formatForInput(field, value) && save(draft)}
          />
        );
    }
  };

  return (
    <>
      {control()}
      <FieldError>{error}</FieldError>
    </>
  );
}
