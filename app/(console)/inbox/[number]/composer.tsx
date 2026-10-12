'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDownIcon, ChevronUpIcon, GlobeIcon, LockIcon } from '@/components/icons';
import { useNow } from '@/components/use-now';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import type { CannedResponseOption } from '@/lib/tickets/lookups';
import type { CannedLocale } from '@/lib/tickets/canned';
import { describeWindow, metaWindowState } from '@/lib/meta/window';
import { consoleReplyNotice, consoleReplyReason } from '@/lib/tickets/channel-policy';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import type { PickerEntry } from '@/lib/side-conversations/queries';
import { StartSideConversationForm } from './side-conversations';
import { ThreadControl } from './thread-control';
import type { KnowledgeContext, TemplateOption } from './types';
import { NoteForm } from './note-form';
import { ReplyForm } from './reply-form';
import { TemplateForm } from './template-form';

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
  suggestCanned,
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
  /** Whether the reply box asks Jev for a canned response. See `lib/canned-suggest/`. */
  suggestCanned: boolean;
  canSideConversation: boolean;
}) {
  const isWhatsApp = conversation.channel === 'whatsapp';
  // Not answered from the console at all: no reply box and no template, only
  // the two tabs that never reach the customer. See `consoleReplyReason`.
  const replyBlocked = consoleReplyReason(conversation.channel);
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

  // The newest reply either way — the message a canned suggestion answers. The
  // timeline arrives in the order the server reads it (`created_at`, then `id`),
  // so this is the same message `lib/canned-suggest/history.ts` calls the anchor.
  const anchorMessageId =
    conversation.messages.findLast((message) => message.kind === 'reply')?.id ?? null;

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

  const onSent = () => setCollapsed(true);

  // Derived rather than forced through an effect: when free-form is impossible
  // the composer shows templates, and it goes back to the reply tab by itself
  // the moment the customer writes again.
  //
  // A channel not answered from here has neither customer-facing tab, so it
  // opens on the private note — without that the default 'reply' would render
  // a reply box under a tab row that does not offer one.
  const tab: Tab = replyBlocked
    ? requestedTab === 'reply' || requestedTab === 'template'
      ? 'note'
      : requestedTab
    : !windowOpen && requestedTab === 'reply'
      ? 'template'
      : requestedTab;

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
  const notice = replyBlocked
    ? consoleReplyNotice(conversation.channel)
    : threadBlocked
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
    /*
      The whole composer turns to amber paper on the note tab, not just the box:
      a note and a reply must look nothing alike at the moment the agent presses
      the button, because only one of them reaches the customer.
    */
    <div
      className={`flex max-h-[65%] min-h-0 flex-col border-t border-(--color-border-subtle) transition-colors ${
        tab === 'note' ? 'bg-(--color-message-note-bg)' : 'bg-(--color-background-surface)'
      }`}
    >
      {/* Shaped like the field it opens, because that is what an agent reaching
          for the bottom of the screen expects to be able to tap. */}
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          aria-controls={PANEL_ID}
          className="flex items-center gap-2 px-3 py-2.5 text-(--color-text-secondary) lg:hidden"
        >
          <span className="min-w-0 flex-1 truncate rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2 text-start text-base">
            {prompt}
          </span>
          <ChevronUpIcon size={18} className="shrink-0" />
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
        {/* Wraps at lg rather than squeezing: with the views panel and the
            details column open the thread pane is under 500px at 1440, and a
            channel notice that may not shrink (it is the warning an agent needs
            before posting publicly) took the whole row, leaving the tabs a
            20px strip. Wrapping drops the notice to its own line instead. */}
        <div className="flex shrink-0 flex-col gap-1 px-3 pt-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {/* One row that scrolls sideways rather than four tabs squeezed into
                a phone's width — at 390px they wrapped onto two lines each and
                the last one ran off the edge. The negative margin lets a tab
                scroll under the padding instead of stopping short of it. */}
            <div className="app-scroll -ms-3 flex items-center gap-1 overflow-x-auto ps-3 lg:ms-0 lg:ps-0">
              {/* Left out rather than disabled: a greyed-out Reply invites the
                  question of when it comes back, and here it does not. */}
              {replyBlocked ? null : (
                <TabButton
                  active={tab === 'reply'}
                  onClick={() => setRequestedTab('reply')}
                  disabled={!windowOpen || !metaSendable}
                  icon={isCommentThread ? <GlobeIcon size={14} /> : null}
                >
                  {isCommentThread ? 'Reply publicly' : 'Reply'}
                </TabButton>
              )}
              <TabButton
                active={tab === 'note'}
                onClick={() => setRequestedTab('note')}
                icon={<LockIcon size={14} />}
                note
              >
                Private note
              </TabButton>
              {isWhatsApp && !replyBlocked ? (
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
              className="ms-auto shrink-0 rounded-md p-1.5 text-(--color-text-secondary) hover:bg-(--color-background-hover) lg:hidden"
            >
              <ChevronDownIcon size={18} />
            </button>
          </div>

          {/* Its own line on a phone. Sharing the tab row left it four characters
              wide and clipped; there is no width to spare down there. */}
          {notice ? (
            <span className="text-xs text-(--color-text-secondary) lg:ms-auto lg:shrink-0">
              {notice}
            </span>
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
              <div className="rounded-md border border-(--color-border-subtle) bg-(--color-background-surface-sunken) p-3 text-sm text-(--color-text-secondary)">
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
                suggest={suggestCanned}
                anchorMessageId={anchorMessageId}
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
  icon,
  note = false,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** The globe on a public reply, the lock on a note: who will read it, not just the colour. */
  icon?: ReactNode;
  /** The note tab, which goes amber when chosen. */
  note?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // amber-100 is the design system's own value for the chosen note tab;
      // there is no role token for it, and the panel under it is note paper.
      className={`flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? note
            ? 'bg-amber-100 font-semibold text-(--color-message-note-fg)'
            : 'bg-(--color-background-hover) font-semibold text-(--color-text-primary)'
          : 'text-(--color-text-secondary) hover:text-(--color-text-primary)'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
