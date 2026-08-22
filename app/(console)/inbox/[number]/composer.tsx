'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import { useNow } from '@/components/use-now';
import type { CannedResponseOption, ConversationDetail } from '@/lib/tickets/queries';
import { insertCanned } from '@/lib/tickets/canned';
import { describeWindow, metaWindowState } from '@/lib/meta/window';
import { renderTemplatePreview, templateShape } from '@/lib/whatsapp/templates';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import type { PickerEntry } from '@/lib/side-conversations/queries';
import { addNote, sendReply, sendTemplateReply, type ActionState } from '../../actions';
import { StartSideConversationForm } from './side-conversations';
import type { TemplateOption } from './view';

const INITIAL: ActionState = { error: null };

type Tab = 'reply' | 'note' | 'template' | 'side';

/** Named so the collapsed bar and the collapse button can both point at it. */
const PANEL_ID = 'composer-panel';

export function Composer({
  conversation,
  templates,
  recipients,
  canned,
  canSideConversation,
}: {
  conversation: ConversationDetail;
  templates: TemplateOption[];
  recipients: PickerEntry[];
  /** Reusable replies this agent may insert — already scoped to them. */
  canned: CannedResponseOption[];
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

  /*
    Collapsed to a single bar on a phone; never on a desktop.

    Expanded, the composer takes two thirds of the pane — which it has to, or
    the taller forms lose their send button — and that is two thirds of a phone
    screen spent on a box the agent is not typing into yet. So it opens as a bar
    and the conversation gets the rest, which is the shape every messaging app
    on a phone already has.

    The state only ever reaches the two `lg:hidden` controls and a `hidden
    lg:flex` panel, so a desktop renders exactly what it rendered before and
    cannot get stuck closed by a stale value from a narrow window.
  */
  const [collapsed, setCollapsed] = useState(true);

  // Stable, because it is an effect dependency down in the forms: a fresh
  // closure every render would re-run the refresh effect on its own output.
  const onSent = useCallback(() => setCollapsed(true), [setCollapsed]);

  // Derived rather than forced through an effect: when free-form is impossible
  // the composer shows templates, and it goes back to the reply tab by itself
  // the moment the customer writes again.
  const tab: Tab = !windowOpen && requestedTab === 'reply' ? 'template' : requestedTab;

  // What the bar says it will open. The tab is the composer's whole subject, and
  // "Write a reply…" against "Write a private note…" is the difference the
  // agent most needs to see before they start typing.
  const prompt: string = {
    reply: isCommentThread ? 'Reply publicly…' : 'Write a reply…',
    note: 'Write a private note…',
    template: 'Send an approved template…',
    side: 'Ask a hub or an internal team…',
  }[tab];

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
      {/* Shaped like the field it opens, because that is what an agent reaching
          for the bottom of the screen expects to be able to tap. */}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-controls={PANEL_ID}
          className="flex items-center gap-2 px-3 py-2.5 text-[var(--muted-foreground)] lg:hidden"
        >
          <span className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-start text-base">
            {prompt}
          </span>
          <ChevronUpIcon size={18} className="shrink-0 opacity-70" />
        </button>
      ) : null}

      {/*
        Hidden rather than unmounted, so a half-written reply survives being put
        away — the fields are uncontrolled and their text lives in the DOM, and
        an agent who collapses the composer to re-read what the customer said is
        the exact case this feature is for.
      */}
      <div
        id={PANEL_ID}
        className={`${collapsed ? 'hidden' : 'flex'} min-h-0 flex-1 flex-col lg:flex`}
      >
        <div className="flex shrink-0 flex-col gap-1 px-3 pt-2 lg:flex-row lg:items-center lg:gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {/* One row that scrolls sideways rather than four tabs squeezed into
                a phone's width — at 390px they wrapped onto two lines each and
                the last one ran off the edge. The negative margin lets a tab
                scroll under the padding instead of stopping short of it. */}
            <div className="app-scroll -ms-3 flex items-center gap-1 overflow-x-auto ps-3 lg:ms-0 lg:ps-0">
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
              {/* Fourth, and last, so the two customer-facing tabs stay leftmost
                  and the muscle memory of "the first box is the one the customer
                  reads" keeps holding. */}
              {canSideConversation ? (
                <TabButton active={tab === 'side'} onClick={() => setRequestedTab('side')}>
                  Side conversation
                </TabButton>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded
              aria-controls={PANEL_ID}
              aria-label="Hide the composer"
              className="ms-auto shrink-0 rounded-md p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)] lg:hidden"
            >
              <ChevronDownIcon size={18} />
            </button>
          </div>

          {/* Its own line on a phone. Sharing the tab row left it four characters
              wide and clipped; there is no width to spare down there. */}
          {notice ? (
            <span className="text-xs opacity-60 lg:ms-auto lg:shrink-0">{notice}</span>
          ) : null}
        </div>

        <div className="app-scroll min-h-0 flex-1 overflow-y-auto p-3">
          {tab === 'reply' ? (
            <ReplyForm
              conversationId={conversation.id}
              isCommentThread={isCommentThread}
              canned={canned}
              onSent={onSent}
            />
          ) : null}
          {tab === 'note' ? <NoteForm conversationId={conversation.id} onSent={onSent} /> : null}
          {tab === 'template' ? (
            <TemplateForm conversationId={conversation.id} templates={templates} onSent={onSent} />
          ) : null}
          {tab === 'side' ? (
            <StartSideConversationForm
              conversation={conversation}
              recipients={recipients}
              onSent={onSent}
            />
          ) : null}
        </div>
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
 *
 * `onSent` puts the composer away on a phone once the message is gone, which is
 * what makes the message land where the agent is looking: the timeline is the
 * thing they want to see after sending, not an empty box. It must be a stable
 * reference — it is a dependency here, and a new closure each render would run
 * this effect against its own refresh.
 */
function useRefreshOnSuccess(state: ActionState, onSent?: () => void) {
  const router = useRouter();
  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
    onSent?.();
  }, [state, router, onSent]);
}

function ReplyForm({
  conversationId,
  isCommentThread = false,
  canned,
  onSent,
}: {
  conversationId: string;
  isCommentThread?: boolean;
  canned: CannedResponseOption[];
  onSent?: () => void;
}) {
  const [state, action] = useActionState(sendReply, INITIAL);
  const [privately, setPrivately] = useState(false);
  useRefreshOnSuccess(state, onSent);

  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /*
    Which canned response went into this reply, for `usage_count`.

    Counted on send rather than on insert, because the column exists to rank
    which responses are worth keeping and "reached for and then abandoned" is
    not a use. It is still an over-count in one direction: an agent who inserts
    one and then rewrites every word of it is recorded as having used it. The
    alternative is diffing the sent body against the stored one and picking a
    similarity threshold, which is a number nobody can defend.

    Last one wins. Inserting two into one reply is real — a greeting and a
    closing — but the column counts replies, not fragments, and attributing the
    reply to both would make the totals add up to more than the replies sent.
  */
  const [usedId, setUsedId] = useState('');

  function insert(response: CannedResponseOption) {
    const box = bodyRef.current;
    if (!box) return;

    const { text, caret } = insertCanned(
      box.value,
      response.bodyText,
      box.selectionStart,
      box.selectionEnd,
    );

    // Written straight to the node, because the textarea is uncontrolled — the
    // form is keyed on the send nonce so the browser keeps the agent's draft
    // through a tab switch, and making it controlled to support this would give
    // that up for every reply in order to serve the ones that use a snippet.
    box.value = text;
    box.focus();
    box.setSelectionRange(caret, caret);
    setUsedId(response.id);
  }

  return (
    <form key={state.nonce ?? 0} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="cannedResponseId" value={usedId} />
      <input
        type="hidden"
        name="metaSendKind"
        value={privately ? 'private_reply' : 'comment_reply'}
      />

      <Textarea
        ref={bodyRef}
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

      <CannedPicker responses={canned} onPick={insert} />

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

/**
 * The canned response picker.
 *
 * A `<select>` rather than a search palette. This codebase has no modals, the
 * list is a handful of rows per team rather than hundreds, and a control that
 * inserts on change is the same gesture every other field in the console uses.
 * If the list ever grows past what a dropdown can carry, the folder grouping
 * below is already the shape a search would filter.
 *
 * It sits under the textarea rather than above it because the box is what the
 * agent came here to type in — a picker above it pushes the thing they want
 * down the screen, on a phone especially.
 *
 * Renders nothing at all when there are none, rather than an empty dropdown
 * that reads as broken. Today that is every console: `canned_responses` is
 * empty in production.
 */
function CannedPicker({
  responses,
  onPick,
}: {
  responses: CannedResponseOption[];
  onPick: (response: CannedResponseOption) => void;
}) {
  if (responses.length === 0) return null;

  // Grouped by folder, with the unfiled ones first — an agent scanning for
  // "Refund approved" reads the folder names as headings rather than as a flat
  // list that happens to be sorted.
  const folders = [...new Set(responses.map((r) => r.folder ?? ''))];

  return (
    <label className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
      <span className="shrink-0">Canned reply</span>
      <Select
        // Always reads "Insert…": it is an action, not a stored value, and a
        // select that kept the last pick would claim the reply still contains
        // something the agent may have since deleted.
        value=""
        onChange={(event) => {
          const picked = responses.find((r) => r.id === event.target.value);
          if (picked) onPick(picked);
        }}
        className="min-w-0 flex-1"
      >
        <option value="">Insert…</option>
        {folders.map((folder) =>
          folder ? (
            <optgroup key={folder} label={folder}>
              {responses
                .filter((r) => (r.folder ?? '') === folder)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
            </optgroup>
          ) : (
            responses
              .filter((r) => (r.folder ?? '') === '')
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))
          ),
        )}
      </Select>
    </label>
  );
}

function NoteForm({ conversationId, onSent }: { conversationId: string; onSent?: () => void }) {
  const [state, action] = useActionState(addNote, INITIAL);
  useRefreshOnSuccess(state, onSent);

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
  onSent,
}: {
  conversationId: string;
  templates: TemplateOption[];
  onSent?: () => void;
}) {
  const [state, action] = useActionState(sendTemplateReply, INITIAL);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  useRefreshOnSuccess(state, onSent);

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
