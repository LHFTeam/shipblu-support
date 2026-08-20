'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import { useNow } from '@/components/use-now';
import type { ConversationDetail } from '@/lib/tickets/queries';
import { describeWindow, metaWindowState } from '@/lib/meta/window';
import { renderTemplatePreview, templateShape } from '@/lib/whatsapp/templates';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import type { PickerEntry } from '@/lib/side-conversations/queries';
import { addNote, sendReply, sendTemplateReply, type ActionState } from '../../actions';
import { StartSideConversationForm } from './side-conversations';
import type { TemplateOption } from './view';

const INITIAL: ActionState = { error: null };

type Tab = 'reply' | 'note' | 'template' | 'side';

export function Composer({
  conversation,
  templates,
  recipients,
  canSideConversation,
}: {
  conversation: ConversationDetail;
  templates: TemplateOption[];
  recipients: PickerEntry[];
  canSideConversation: boolean;
}) {
  const isWhatsApp = conversation.channel === 'whatsapp';
  const isMeta = conversation.channel === 'facebook' || conversation.channel === 'instagram';
  // A comment ticket carries the root comment in its external id; a direct
  // message ticket has none. That is what decides whether the agent is writing
  // in public or in private.
  const isCommentThread = Boolean(conversation.externalId?.includes(':comment:'));
  const now = useNow();

  const state = windowState(
    conversation.lastCustomerMessageAt ? new Date(conversation.lastCustomerMessageAt) : null,
    now ?? undefined,
  );

  // Before mount, assume the window is open rather than showing "closed" for a
  // frame — a false "closed" reads as broken, whereas a false "open" corrects
  // itself on the first tick and the send path re-checks regardless.
  const windowOpen = !isWhatsApp || now === null || state.isOpen;

  const metaState = metaWindowState(
    conversation.lastCustomerMessageAt ? new Date(conversation.lastCustomerMessageAt) : null,
    now ?? undefined,
  );
  // Comments are public and have no messaging window at all, so only a direct
  // message ticket can be locked out.
  const metaSendable = !isMeta || isCommentThread || now === null || !metaState.isClosed;

  const [requestedTab, setRequestedTab] = useState<Tab>('reply');

  // Derived rather than forced through an effect: when free-form is impossible
  // the composer shows templates, and it goes back to the reply tab by itself
  // the moment the customer writes again.
  const tab: Tab = !windowOpen && requestedTab === 'reply' ? 'template' : requestedTab;

  // The note beside the tabs, if this channel has one to make.
  const notice =
    isWhatsApp && now !== null
      ? state.isOpen
        ? `24h window: ${formatRemaining(state.remainingMs)}`
        : 'Window closed — approved templates only'
      : isMeta && !isCommentThread && now !== null
        ? describeWindow(metaState)
        : isCommentThread
          ? 'Public comment thread — anyone who can see the post can read your reply'
          : null;

  return (
    /*
      Capped rather than free-standing, and scrolling inside that cap.

      The pane it sits in is `overflow-hidden`, so a composer taller than the
      space left over does not push a scrollbar — it is simply cut off, taking
      the send button with it. The side conversation form is the tall one and a
      short phone is where it happens: an agent on a 667px screen could fill the
      whole form in and never reach "Send". So the composer takes at most two
      thirds of the pane and scrolls within it, which also leaves the last
      messages of the conversation on screen while writing.
    */
    <div className="flex max-h-[65%] min-h-0 flex-col border-t border-[var(--border)]">
      <div className="flex shrink-0 flex-col gap-1 px-3 pt-2 lg:flex-row lg:items-center lg:gap-2">
        {/* One row that scrolls sideways rather than four tabs squeezed into a
            phone's width — at 390px they wrapped onto two lines each and the
            last one ran off the edge. The negative margin lets a tab scroll
            under the padding instead of stopping short of it. */}
        <div className="app-scroll -mx-3 flex items-center gap-1 overflow-x-auto px-3 lg:mx-0 lg:px-0">
          <TabButton
            active={tab === 'reply'}
            onClick={() => setRequestedTab('reply')}
            disabled={!windowOpen || !metaSendable}
          >
            {isCommentThread ? 'Reply publicly' : 'Reply'}
          </TabButton>
          <TabButton active={tab === 'note'} onClick={() => setRequestedTab('note')}>
            Private note
          </TabButton>
          {isWhatsApp ? (
            <TabButton active={tab === 'template'} onClick={() => setRequestedTab('template')}>
              Template
            </TabButton>
          ) : null}
          {/* Fourth, and last, so the two customer-facing tabs stay leftmost and
              the muscle memory of "the first box is the one the customer reads"
              keeps holding. */}
          {canSideConversation ? (
            <TabButton active={tab === 'side'} onClick={() => setRequestedTab('side')}>
              Side conversation
            </TabButton>
          ) : null}
        </div>

        {/* Its own line on a phone. Sharing the tab row left it four characters
            wide and clipped; there is no width to spare down there. */}
        {notice ? (
          <span className="text-xs opacity-60 lg:ms-auto lg:shrink-0">{notice}</span>
        ) : null}
      </div>

      <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'reply' ? (
          <ReplyForm conversationId={conversation.id} isCommentThread={isCommentThread} />
        ) : null}
        {tab === 'note' ? <NoteForm conversationId={conversation.id} /> : null}
        {tab === 'template' ? (
          <TemplateForm conversationId={conversation.id} templates={templates} />
        ) : null}
        {tab === 'side' ? (
          <StartSideConversationForm conversation={conversation} recipients={recipients} />
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
      className={`shrink-0 rounded-t-md px-3 py-1.5 text-sm whitespace-nowrap ${
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

function ReplyForm({
  conversationId,
  isCommentThread = false,
}: {
  conversationId: string;
  isCommentThread?: boolean;
}) {
  const [state, action] = useActionState(sendReply, INITIAL);
  const [privately, setPrivately] = useState(false);
  useRefreshOnSuccess(state);

  return (
    <form key={state.nonce ?? 0} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input
        type="hidden"
        name="metaSendKind"
        value={privately ? 'private_reply' : 'comment_reply'}
      />

      <Textarea
        name="body"
        rows={4}
        placeholder={
          isCommentThread
            ? privately
              ? 'Send this privately to the commenter — one chance per comment.'
              : 'Reply under the comment, where everyone can see it…'
            : 'Write a reply to the customer…'
        }
        required
      />

      {isCommentThread ? (
        <label className="flex items-start gap-2 rounded-md border border-[var(--border)] p-2 text-xs">
          <input
            type="checkbox"
            checked={privately}
            onChange={(event) => setPrivately(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Reply privately instead</span>
            <span className="block opacity-60">
              Moves the conversation into the direct message inbox. Meta allows this once per
              comment, so it cannot be undone or repeated.
            </span>
          </span>
        </label>
      ) : null}

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
