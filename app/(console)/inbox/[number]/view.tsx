'use client';

import type { ConversationDetail } from '@/lib/tickets/conversation';
import type { CannedResponseOption } from '@/lib/tickets/lookups';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import type { SubcategoryOption, RootCauseOption } from '@/lib/subcategorise/queries';
import type { PurgePreview } from '@/lib/admin/purge-summary';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import type { PickerEntry } from '@/lib/side-conversations/queries';
import type { CannedLocale } from '@/lib/tickets/canned';
import { BotIcon, WarningIcon } from '@/components/icons';
import { Composer } from './composer';
import type { KnowledgeContext, TemplateOption } from './types';
import { Header } from './header';
import { Timeline } from './timeline';
import { Sidebar } from './sidebar';

/**
 * What sits where the composer would be, on a channel we only observe.
 *
 * A disabled textarea was the other option and is worse: it invites the agent to
 * try, and leaves them guessing why nothing happens. Saying plainly that the
 * conversation is not ours to answer is shorter and answers the question they
 * were about to ask.
 */
function ReadOnlyNotice({ reason, oneSided }: { reason: string; oneSided: boolean }) {
  return (
    <div className="shrink-0 border-t border-(--color-border-subtle) p-3">
      {/* Dashed, with the bot, because the bot is what owns this thread: the
          dashed edge is the console's one sign for something a machine wrote. */}
      <div className="flex gap-2.5 rounded-md border border-dashed border-(--color-border-strong) bg-(--color-background-surface-sunken) p-3 text-sm/5 text-(--color-text-secondary)">
        <BotIcon size={18} className="mt-px shrink-0" />
        <div className="min-w-0">
          <p>{reason}</p>

          {/*
            Said only when the other half is genuinely absent, and it disappears
            by itself the moment an echo lands. Without it a transcript with no
            replies in it reads as a customer talking to nobody — which is a
            different and much more alarming thing than a delivery setting being
            off.
          */}
          {oneSided ? (
            <p className="mt-2 flex items-start gap-2 text-xs text-(--color-feedback-warning-fg)">
              <WarningIcon size={14} className="mt-0.5 shrink-0" />
              <span>
                Only the customer&apos;s side of this conversation is here. The bot&apos;s replies
                reach us as Meta message echoes, and none have arrived — so the{' '}
                <span className="font-medium">message_echoes</span> field is not subscribed for this
                WhatsApp account.
              </span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ConversationView({
  conversation,
  statuses,
  agents,
  groups,
  templates,
  recipients,
  fields,
  canned,
  customerLocale,
  knowledge,
  suggestCanned,
  canSideConversation,
  canModerateComments,
  canEditContact,
  canClose,
  canSubcategorise,
  subcategoryOptions,
  rootCauses,
  purgePreview,
  purgeRefusal,
  currentAgentId,
  canViewContact,
}: {
  conversation: ConversationDetail;
  statuses: { id: string; name: string; category: string }[];
  agents: { id: string; name: string; email: string }[];
  groups: { id: string; name: string }[];
  templates: TemplateOption[];
  /** The admin-defined ticket fields, in the order they were arranged. */
  fields: TicketFieldDef[];
  /** The internal directory, for the composer's side conversation tab. */
  recipients: PickerEntry[];
  /** Reusable replies, already scoped to this agent's own and their groups'. */
  canned: CannedResponseOption[];
  /** The language the customer writes in, which the canned picker starts on. */
  customerLocale: CannedLocale;
  /** Null when the agent lacks `kb.view`, or on a channel with no composer. */
  knowledge: KnowledgeContext | null;
  /** Whether the reply box asks Jev for a canned response. */
  suggestCanned: boolean;
  canSideConversation: boolean;
  /** Whether this agent may hide or delete a public comment. */
  canModerateComments: boolean;
  /** Whether this agent may re-read the customer's profile from Meta. */
  canEditContact: boolean;
  /** Whether this agent may end the customer's thread. See `ticket.close`. */
  canClose: boolean;
  /** Whether this agent may correct what a ticket is filed under. */
  canSubcategorise: boolean;
  /** The active taxonomy, for the picker. Empty until the seed has run. */
  subcategoryOptions: SubcategoryOption[];
  rootCauses: RootCauseOption[];
  /** Non-null only for an admin holding `ticket.purge`; see the sidebar. */
  purgePreview: PurgePreview | null;
  /** Why that admin still may not purge it; see `hiddenScopeRefusal()`. */
  purgeRefusal: string | null;
  currentAgentId: string;
  /** Whether this agent may open the contact's page; see the sidebar's Contact tab. */
  canViewContact: boolean;
}) {
  return (
    // From `md` the thread is a white panel on the inbox's grey, as the list
    // beside it is; the details column paints its own. On a phone the ticket is
    // the whole screen, so there is no canvas to float on and no corner to round.
    <div className="flex h-full md:gap-(--console-gap)">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-(--color-thread-bg) md:rounded-(--console-panel-radius)">
        <Header
          conversation={conversation}
          canEditContact={canEditContact}
          canViewContact={canViewContact}
        />

        {/*
          Positioned so it is the containing block for anything absolutely
          positioned in the thread — `sr-only` text included. Without it such a
          box is placed against the document, past every `overflow-hidden`, and
          lengthens the page under the console (PROJECT-STATE §6.81).
        */}
        <div className="app-scroll relative min-h-0 flex-1 overflow-y-auto bg-(--color-thread-bg) px-3 py-4 md:px-6 md:pt-6 md:pb-5">
          <Timeline
            conversation={conversation}
            canSideConversation={canSideConversation}
            canModerateComments={canModerateComments}
            canViewContact={canViewContact}
          />
        </div>

        {readOnlyReason(conversation.channel) ? (
          <ReadOnlyNotice
            reason={readOnlyReason(conversation.channel)!}
            oneSided={!conversation.messages.some((m) => m.direction === 'outbound')}
          />
        ) : (
          <Composer
            conversation={conversation}
            templates={templates}
            recipients={recipients}
            canned={canned}
            customerLocale={customerLocale}
            knowledge={knowledge}
            suggestCanned={suggestCanned}
            canSideConversation={canSideConversation}
          />
        )}
      </div>

      <Sidebar
        conversation={conversation}
        statuses={statuses}
        agents={agents}
        groups={groups}
        fields={fields}
        canClose={canClose}
        canSubcategorise={canSubcategorise}
        subcategoryOptions={subcategoryOptions}
        rootCauses={rootCauses}
        purgePreview={purgePreview}
        purgeRefusal={purgeRefusal}
        currentAgentId={currentAgentId}
        canViewContact={canViewContact}
      />
    </div>
  );
}
