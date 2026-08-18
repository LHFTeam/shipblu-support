'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import { useNow } from '@/components/use-now';
import type { ConversationDetail } from '@/lib/tickets/queries';
import { renderTemplatePreview, templateShape } from '@/lib/whatsapp/templates';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import { addNote, sendReply, sendTemplateReply, type ActionState } from '../../actions';
import type { TemplateOption } from './view';

const INITIAL: ActionState = { error: null };

type Tab = 'reply' | 'note' | 'template';

export function Composer({
  conversation,
  templates,
}: {
  conversation: ConversationDetail;
  templates: TemplateOption[];
}) {
  const isWhatsApp = conversation.channel === 'whatsapp';
  const now = useNow();

  const state = windowState(
    conversation.lastCustomerMessageAt ? new Date(conversation.lastCustomerMessageAt) : null,
    now ?? undefined,
  );

  // Before mount, assume the window is open rather than showing "closed" for a
  // frame — a false "closed" reads as broken, whereas a false "open" corrects
  // itself on the first tick and the send path re-checks regardless.
  const windowOpen = !isWhatsApp || now === null || state.isOpen;

  const [requestedTab, setRequestedTab] = useState<Tab>('reply');

  // Derived rather than forced through an effect: when free-form is impossible
  // the composer shows templates, and it goes back to the reply tab by itself
  // the moment the customer writes again.
  const tab: Tab = !windowOpen && requestedTab === 'reply' ? 'template' : requestedTab;

  return (
    <div className="shrink-0 border-t border-[var(--border)]">
      <div className="flex items-center gap-1 px-3 pt-2">
        <TabButton
          active={tab === 'reply'}
          onClick={() => setRequestedTab('reply')}
          disabled={!windowOpen}
        >
          Reply
        </TabButton>
        <TabButton active={tab === 'note'} onClick={() => setRequestedTab('note')}>
          Private note
        </TabButton>
        {isWhatsApp ? (
          <TabButton active={tab === 'template'} onClick={() => setRequestedTab('template')}>
            Template
          </TabButton>
        ) : null}

        {isWhatsApp && now !== null ? (
          <span className="ml-auto text-xs opacity-60">
            {state.isOpen
              ? `24h window: ${formatRemaining(state.remainingMs)}`
              : 'Window closed — approved templates only'}
          </span>
        ) : null}
      </div>

      <div className="p-3">
        {tab === 'reply' ? <ReplyForm conversationId={conversation.id} /> : null}
        {tab === 'note' ? <NoteForm conversationId={conversation.id} /> : null}
        {tab === 'template' ? (
          <TemplateForm conversationId={conversation.id} templates={templates} />
        ) : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-t-md px-3 py-1.5 text-sm ${
        active ? 'bg-[var(--muted)] font-medium' : 'opacity-60 hover:opacity-100'
      } disabled:cursor-not-allowed disabled:opacity-30`}
    >
      {children}
    </button>
  );
}

/**
 * Re-reads the server components after a successful action, so the timeline
 * shows the message that was just written.
 *
 * The fields clear by remounting the form on `state.nonce` rather than by
 * resetting controlled state — the inputs stay uncontrolled, which is also what
 * lets the browser keep a draft through an accidental tab switch.
 */
function useRefreshOnSuccess(state: ActionState) {
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state, router]);
}

function ReplyForm({ conversationId }: { conversationId: string }) {
  const [state, action] = useActionState(sendReply, INITIAL);
  useRefreshOnSuccess(state);

  return (
    <form key={state.nonce ?? 0} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />

      <Textarea name="body" rows={4} placeholder="Write a reply to the customer…" required />

      <ErrorText>{state.error}</ErrorText>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs opacity-70">
          <input type="checkbox" name="resolveAfter" />
          Resolve after sending
        </label>
        <SubmitButton className="ml-auto" idle="Send reply" busy="Sending…" />
      </div>
    </form>
  );
}

function NoteForm({ conversationId }: { conversationId: string }) {
  const [state, action] = useActionState(addNote, INITIAL);
  useRefreshOnSuccess(state);

  return (
    <form key={state.nonce ?? 0} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />

      <Textarea
        name="body"
        rows={3}
        placeholder="Visible to agents only — never sent to the customer."
        className="border-amber-500/40 bg-amber-500/5"
        required
      />

      <ErrorText>{state.error}</ErrorText>

      <SubmitButton className="self-end" idle="Add note" busy="Saving…" />
    </form>
  );
}

/**
 * Template send.
 *
 * The variable inputs are generated from the components synced from Meta, and
 * the preview substitutes them live — outside the 24-hour window this is the
 * only way an agent can see what the customer will actually receive, and a
 * wrong parameter count comes back from Meta as an error code explaining
 * nothing.
 */
function TemplateForm({
  conversationId,
  templates,
}: {
  conversationId: string;
  templates: TemplateOption[];
}) {
  const [state, action] = useActionState(sendTemplateReply, INITIAL);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  useRefreshOnSuccess(state);

  const template = templates.find((t) => t.id === templateId);
  const shape = template ? templateShape(template.components) : null;

  if (templates.length === 0) {
    return (
      <p className="text-sm opacity-60">
        No approved templates are synced yet. They appear here within an hour of being approved in
        Meta Business Manager.
      </p>
    );
  }

  const bodyValues = Array.from(
    { length: shape?.bodyVariableCount ?? 0 },
    (_, index) => values[`body_${index + 1}`] ?? '',
  );

  return (
    <form action={action} className="flex flex-col gap-3">
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

      <ErrorText>{state.error}</ErrorText>

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

function SubmitButton({
  idle,
  busy,
  className,
}: {
  idle: string;
  busy: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={className}>
      {pending ? busy : idle}
    </Button>
  );
}
