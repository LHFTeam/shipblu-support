'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import { useNow } from '@/components/use-now';
import type { AgentArticleHit } from '@/lib/kb/agent-search';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import type { CannedResponseOption } from '@/lib/tickets/lookups';
import {
  availableLocales,
  CANNED_LOCALES,
  insertCanned,
  resolveLocale,
  type CannedLocale,
} from '@/lib/tickets/canned';
import { describeWindow, metaWindowState } from '@/lib/meta/window';
import { renderTemplatePreview, templateShape } from '@/lib/whatsapp/templates';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import type { PickerEntry } from '@/lib/side-conversations/queries';
import type { ActionState } from '../../action-state';
import { addNote, sendReply, sendTemplateReply } from '../../reply-actions';
import { KnowledgePanel } from './knowledge';
import { StartSideConversationForm } from './side-conversations';
import { ThreadControl } from './thread-control';
import type { TemplateOption } from './types';

const INITIAL: ActionState = { error: null };

/**
 * The language toggle's two buttons, each written in its own script.
 *
 * "العربية" is what an Arabic reply looks like, which is the thing the agent is
 * choosing; "AR" beside "EN" is two Latin abbreviations that have to be decoded
 * first.
 */
const LOCALE_LABELS: Record<CannedLocale, string> = { ar: 'العربية', en: 'English' };

/**
 * The same two languages, named in English for the middle of a sentence.
 *
 * A dropdown option is one bidirectional run — "Delivery delay apology —
 * العربية only" puts an RTL span inside an LTR line and the browser reorders
 * the dash and the word "only" around it. The console is English throughout, so
 * the option says "Arabic only" and the button an agent presses stays native.
 */
const LOCALE_NAMES: Record<CannedLocale, string> = { ar: 'Arabic', en: 'English' };

/** The two bodies of a response, in the shape `lib/tickets/canned` reads. */
function bodiesOf(response: CannedResponseOption) {
  return { ar: response.bodyTextAr, en: response.bodyTextEn };
}

/**
 * What the knowledge panel needs, or null when the agent lacks `kb.view`.
 *
 * Passed as one object rather than two props so "this agent has no knowledge
 * panel" is a single null to check, in the same shape the sidebar's optional
 * sections use.
 */
export type KnowledgeContext = {
  suggestions: AgentArticleHit[];
  /** The customer's language, read off the script of what they last wrote. */
  locale: 'ar' | 'en';
};

type Tab = 'reply' | 'note' | 'template' | 'side';

/** Named so the collapsed bar and the collapse button can both point at it. */
const PANEL_ID = 'composer-panel';

export function Composer({
  conversation,
  templates,
  recipients,
  canned,
  customerLocale,
  knowledge,
  canSideConversation,
}: {
  conversation: ConversationDetail;
  templates: TemplateOption[];
  recipients: PickerEntry[];
  /** Reusable replies this agent may insert — already scoped to them. */
  canned: CannedResponseOption[];
  /**
   * The language the customer is writing in, from the script of their last
   * message. The same reading the knowledge panel searches on, passed
   * separately because it seeds the canned-response toggle for every agent —
   * including the ones without `kb.view`, who get no `knowledge` at all.
   */
  customerLocale: CannedLocale;
  knowledge: KnowledgeContext | null;
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

  // Not a clock at all, and not something the agent can wait out: the thread
  // belongs to another app, or to a page this deployment cannot send from.
  // Server-computed, so unlike the window it needs no mount guard.
  const metaThread = conversation.metaThread;
  const threadBlocked = Boolean(metaThread && !metaThread.canSend);

  // Comments are public and have no messaging window at all, so only a direct
  // message ticket can be locked out.
  const metaSendable =
    !threadBlocked && (!isMeta || isCommentThread || now === null || !metaState.isClosed);

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
  // The thread verdict outranks the clock: "3h left to reply freely" over a
  // ticket nothing can be sent on is worse than no notice at all.
  const notice = threadBlocked
    ? metaThread?.reason === 'standby'
      ? 'Another app owns this inbox — this ticket can be read here but not answered'
      : 'This ticket cannot be answered from here — see the message below'
    : isWhatsApp && now !== null
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
            /*
              The explanation stands in for the textarea rather than sitting
              above it. Disabling the tab does nothing here — 'reply' is already
              the active tab, so the form rendered anyway and an agent could
              write a full answer before the action refused it. Saying why up
              front costs them the paragraph they would otherwise lose.
            */
            threadBlocked ? (
              <div className="rounded-md border border-[var(--border)] bg-[var(--muted)] p-3 text-sm text-[var(--muted-foreground)]">
                <p className="whitespace-pre-line">{metaThread?.explanation}</p>
                {/*
                  Only under the standby refusal. The other two the thread state
                  can give — a page this deployment cannot address, an account id
                  that is not set — are not thread control and would not be fixed
                  by taking it; offering the button there would send an agent
                  pressing it at a refusal that has nothing to do with handover.
                */}
                {metaThread?.reason === 'standby' ? (
                  <ThreadControl conversationId={conversation.id} />
                ) : null}
              </div>
            ) : (
              <ReplyForm
                conversationId={conversation.id}
                isCommentThread={isCommentThread}
                canned={canned}
                customerLocale={customerLocale}
                knowledge={knowledge}
                onSent={onSent}
              />
            )
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
  customerLocale,
  knowledge,
  onSent,
}: {
  conversationId: string;
  isCommentThread?: boolean;
  canned: CannedResponseOption[];
  customerLocale: CannedLocale;
  knowledge: KnowledgeContext | null;
  onSent?: () => void;
}) {
  const [state, action] = useActionState(sendReply, INITIAL);
  const [privately, setPrivately] = useState(false);
  useRefreshOnSuccess(state, onSent);

  /*
    Which language the next canned response goes in.

    Above the `key={state.nonce}` boundary deliberately, beside `privately`, and
    for the reason `docs/PROJECT-STATE.md` §6.58 gives: what may survive a send
    here is a *visible control*, never a hidden field. The toggle is on screen showing which
    language the next insertion will use, so an agent can see what carried over
    — and it should carry over. Somebody who has decided to answer an Arabic
    ticket in English is answering the whole thread in English, and a toggle
    that snapped back to the customer's script on every send would undo that
    decision between the greeting and the sign-off.
  */
  const [cannedLocale, setCannedLocale] = useState<CannedLocale>(customerLocale);

  return (
    <form key={state.nonce ?? 0} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input
        type="hidden"
        name="metaSendKind"
        value={privately ? 'private_reply' : 'comment_reply'}
      />

      <ReplyBody
        isCommentThread={isCommentThread}
        privately={privately}
        canned={canned}
        locale={cannedLocale}
        onLocaleChange={setCannedLocale}
        knowledge={knowledge}
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

/**
 * The reply box, and the two controls that write into it.
 *
 * A component of its own so that the `key` on the form resets what it
 * remembers. React state lives with the component that declares it, and
 * `usedId` declared in `ReplyForm` outlived the remount that clears the
 * textarea: the reply after one that used a canned response posted the same
 * `cannedResponseId` again, and `countCannedUse` incremented `usage_count` for
 * a response that reply never contained — once more for every reply the agent
 * sent before leaving the ticket. The column exists to rank what the team
 * reaches for, so an over-count that compounds with traffic is worse than no
 * column.
 *
 * `privately` stays in the parent deliberately: it is the send *mode*, and the
 * server re-derives it from the conversation anyway (`metaSendKind` is forced
 * to `dm` off a comment thread), so a stale tick cannot change where a message
 * goes.
 */
function ReplyBody({
  isCommentThread,
  privately,
  canned,
  locale,
  onLocaleChange,
  knowledge,
}: {
  isCommentThread: boolean;
  privately: boolean;
  canned: CannedResponseOption[];
  /** The language the picker inserts, owned by the form above — see there. */
  locale: CannedLocale;
  onLocaleChange: (locale: CannedLocale) => void;
  knowledge: KnowledgeContext | null;
}) {
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

  /*
    Two things insert into this box now — a canned response and an article link
    — and they want identical caret handling and different bookkeeping. Taking
    text rather than a row keeps `insertCanned`'s off-by-one in one place and
    leaves `usage_count`, which is about canned responses specifically, to the
    one caller that owes it.
  */
  const insertText = useCallback((snippet: string) => {
    const box = bodyRef.current;
    if (!box) return;

    const { text, caret } = insertCanned(box.value, snippet, box.selectionStart, box.selectionEnd);

    // Written straight to the node, because the textarea is uncontrolled — the
    // form is keyed on the send nonce so the browser keeps the agent's draft
    // through a tab switch, and making it controlled to support this would give
    // that up for every reply in order to serve the ones that use a snippet.
    box.value = text;
    box.focus();
    box.setSelectionRange(caret, caret);
  }, []);

  const insertCannedResponse = useCallback(
    (response: CannedResponseOption, locale: CannedLocale) => {
      const bodies = bodiesOf(response);

      // The language it was actually written in, which is the one the option
      // said it would insert. Null means a response with neither body — nothing
      // `saveCannedResponse` can create, and nothing to put in the box.
      const chosen = resolveLocale(bodies, locale);
      if (!chosen) return;

      insertText(bodies[chosen]);
      setUsedId(response.id);
    },
    [insertText],
  );

  return (
    <>
      <input type="hidden" name="cannedResponseId" value={usedId} />

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

      <CannedPicker
        responses={canned}
        locale={locale}
        onLocaleChange={onLocaleChange}
        onPick={insertCannedResponse}
      />

      {knowledge ? (
        <KnowledgePanel
          suggestions={knowledge.suggestions}
          locale={knowledge.locale}
          onInsert={insertText}
        />
      ) : null}
    </>
  );
}

/**
 * The canned response picker, and the language it inserts.
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
 * that reads as broken.
 *
 * **The language is a control beside the list, not a second list.** Two entries
 * per response would double a dropdown an agent scans by eye, and it would put
 * the choice they rarely change — the customer is writing in one language, and
 * they will use that one for every response in the reply — in front of them on
 * every pick. So it is one toggle, set from the script of what the customer
 * actually wrote, and an agent answering an English mail in Arabic flips it
 * once. A response that has only the other language says so on its own option
 * rather than disappearing from the list; see `resolveLocale`.
 */
function CannedPicker({
  responses,
  locale,
  onLocaleChange,
  onPick,
}: {
  responses: CannedResponseOption[];
  locale: CannedLocale;
  onLocaleChange: (locale: CannedLocale) => void;
  onPick: (response: CannedResponseOption, locale: CannedLocale) => void;
}) {
  if (responses.length === 0) return null;

  // Grouped by folder, with the unfiled ones first — an agent scanning for
  // "Refund approved" reads the folder names as headings rather than as a flat
  // list that happens to be sorted.
  const folders = [...new Set(responses.map((r) => r.folder ?? ''))];

  const label = (response: CannedResponseOption) => {
    const available = availableLocales(bodiesOf(response));

    // Only worth saying when the response cannot answer the language the
    // toggle is set to. A response carrying both is the ordinary case, and
    // marking every line would bury the exceptions in the noise.
    if (available.length === 1 && available[0] !== locale) {
      return `${response.title} — ${LOCALE_NAMES[available[0]!]} only`;
    }

    return response.title;
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">Canned reply</span>
        <Select
          // Always reads "Insert…": it is an action, not a stored value, and a
          // select that kept the last pick would claim the reply still contains
          // something the agent may have since deleted.
          value=""
          onChange={(event) => {
            const picked = responses.find((r) => r.id === event.target.value);
            if (picked) onPick(picked, locale);
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
                      {label(r)}
                    </option>
                  ))}
              </optgroup>
            ) : (
              responses
                .filter((r) => (r.folder ?? '') === '')
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {label(r)}
                  </option>
                ))
            ),
          )}
        </Select>
      </label>

      <div
        role="group"
        aria-label="Canned reply language"
        className="flex shrink-0 overflow-hidden rounded-md border border-[var(--border)]"
      >
        {CANNED_LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            // The pressed state, not a radio: this changes what the next pick
            // inserts and nothing about the reply being submitted, so it must
            // not travel with the form.
            aria-pressed={option === locale}
            onClick={() => onLocaleChange(option)}
            className={
              option === locale
                ? 'bg-brand-600 px-2 py-1 font-medium text-white'
                : 'px-2 py-1 hover:bg-[var(--muted)]'
            }
          >
            {LOCALE_LABELS[option]}
          </button>
        ))}
      </div>
    </div>
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
