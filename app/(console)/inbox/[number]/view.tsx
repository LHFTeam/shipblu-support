'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { InfoTip } from '@/components/tooltip';
import { Badge } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import type { CannedResponseOption } from '@/lib/tickets/lookups';
import { type TicketFieldDef } from '@/lib/tickets/custom-fields';
import type { CategoryOption, RootCauseOption } from '@/lib/categorise/queries';
import { PRIORITIES } from '@/lib/tickets/vocabulary';
import { purgeTicket } from '../../ticket-actions';
import {
  addCategory,
  confirmCategory,
  rejectCategory,
  removeCategory,
  setRootCause,
} from '../../category-actions';
import { PurgePanel } from '../../purge-panel';
import type { PurgePreview } from '@/lib/admin/purge-summary';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import type { PickerEntry } from '@/lib/side-conversations/queries';
import type { CannedLocale } from '@/lib/tickets/canned';
import { Composer, type KnowledgeContext } from './composer';
import { SideConversationsField } from './side-conversations';
import type { TemplateOption } from './types';
import { Header } from './header';
import { Timeline } from './timeline';
import { CustomFields, FieldSelect, SidebarField, TagField } from './ticket-fields';
import { ShipmentsField, ShippingAccountsField } from './shipments-field';
import { type LinkAction, UnlinkButton } from './unlink-button';
import { describeEvent } from '@/lib/tickets/event-labels';

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
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--muted)] px-4 py-3">
      <p className="flex items-start gap-2 text-xs text-[var(--muted-foreground)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0"
        >
          <rect x="4" y="10.5" width="16" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
        <span>{reason}</span>
      </p>

      {/*
        Said only when the other half is genuinely absent, and it disappears by
        itself the moment an echo lands. Without it a transcript with no replies
        in it reads as a customer talking to nobody — which is a different and
        much more alarming thing than a delivery setting being off.
      */}
      {oneSided ? (
        <p className="mt-2 flex items-start gap-2 text-xs text-amber-700">
          <span aria-hidden="true" className="mt-0.5">
            ⚠
          </span>
          <span>
            Only the customer&apos;s side of this conversation is here. The bot&apos;s replies reach
            us as Meta message echoes, and none have arrived — so the{' '}
            <span className="font-medium">message_echoes</span> field is not subscribed for this
            WhatsApp account.
          </span>
        </p>
      ) : null}
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
  canSideConversation,
  canModerateComments,
  canEditContact,
  canClose,
  canCategorise,
  categoryOptions,
  rootCauses,
  purgePreview,
  purgeRefusal,
  currentAgentId,
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
  canSideConversation: boolean;
  /** Whether this agent may hide or delete a public comment. */
  canModerateComments: boolean;
  /** Whether this agent may re-read the customer's profile from Meta. */
  canEditContact: boolean;
  /** Whether this agent may end the customer's thread. See `ticket.close`. */
  canClose: boolean;
  /** Whether this agent may correct what a ticket is filed under. */
  canCategorise: boolean;
  /** The active taxonomy, for the picker. Empty until the seed has run. */
  categoryOptions: CategoryOption[];
  rootCauses: RootCauseOption[];
  /** Non-null only for an admin holding `ticket.purge`; see the sidebar. */
  purgePreview: PurgePreview | null;
  /** Why that admin still may not purge it; see `hiddenScopeRefusal()`. */
  purgeRefusal: string | null;
  currentAgentId: string;
}) {
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header conversation={conversation} canEditContact={canEditContact} />

        <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <Timeline
            conversation={conversation}
            canSideConversation={canSideConversation}
            canModerateComments={canModerateComments}
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
        canCategorise={canCategorise}
        categoryOptions={categoryOptions}
        rootCauses={rootCauses}
        purgePreview={purgePreview}
        purgeRefusal={purgeRefusal}
        currentAgentId={currentAgentId}
      />
    </div>
  );
}

function Sidebar({
  conversation,
  statuses,
  agents,
  groups,
  fields,
  canClose,
  canCategorise,
  categoryOptions,
  rootCauses,
  purgePreview,
  purgeRefusal,
  currentAgentId,
}: {
  conversation: ConversationDetail;
  statuses: { id: string; name: string; category: string }[];
  agents: { id: string; name: string; email: string }[];
  groups: { id: string; name: string }[];
  fields: TicketFieldDef[];
  canClose: boolean;
  canCategorise: boolean;
  categoryOptions: CategoryOption[];
  rootCauses: RootCauseOption[];
  purgePreview: PurgePreview | null;
  purgeRefusal: string | null;
  currentAgentId: string;
}) {
  return (
    <aside className="app-scroll hidden w-64 shrink-0 overflow-y-auto border-s border-[var(--border)] bg-[var(--surface)] p-3 xl:block">
      <SidebarField
        label="Status"
        // One line rather than an InfoTip: an agent who used to have Closed in
        // this list needs to know where it went without going looking, and the
        // sidebar is too dense to spend a paragraph on it.
        hint={canClose ? undefined : 'Resolved tickets close themselves after 3 days.'}
      >
        <FieldSelect
          conversationId={conversation.id}
          field="status"
          value={conversation.statusId}
          options={statuses
            // The ticket's own status stays in the list whatever it is: dropping
            // it would leave the select showing some other status as though the
            // ticket were in it, which is worse than offering an option the
            // action will refuse anyway.
            .filter((s) => canClose || s.category !== 'closed' || s.id === conversation.statusId)
            .map((s) => ({ value: s.id, label: s.name }))}
        />
      </SidebarField>

      <SidebarField label="Assignee">
        <FieldSelect
          conversationId={conversation.id}
          field="assignee"
          value={conversation.assigneeAgentId ?? ''}
          options={[
            { value: '', label: 'Unassigned' },
            ...agents.map((a) => ({
              value: a.id,
              label: a.id === currentAgentId ? `${a.name} (me)` : a.name,
            })),
          ]}
        />
      </SidebarField>

      <SidebarField label="Group">
        <FieldSelect
          conversationId={conversation.id}
          field="group"
          value={conversation.groupId ?? ''}
          options={[
            { value: '', label: 'None' },
            ...groups.map((g) => ({ value: g.id, label: g.name })),
          ]}
        />
      </SidebarField>

      <SidebarField label="Priority">
        <FieldSelect
          conversationId={conversation.id}
          field="priority"
          value={conversation.priority}
          options={PRIORITIES.map((p) => ({ value: p, label: p }))}
        />
      </SidebarField>

      <SidebarField label="Tags">
        <TagField conversationId={conversation.id} tags={conversation.tags} />
      </SidebarField>

      <CustomFields conversation={conversation} fields={fields} />

      <CategoriesField
        conversation={conversation}
        options={categoryOptions}
        rootCauses={rootCauses}
        canCategorise={canCategorise}
      />
      <ShipmentsField conversation={conversation} />
      <ShippingAccountsField conversation={conversation} />

      <SidebarField label="Side conversations">
        <SideConversationsField sides={conversation.sideConversations} />
      </SidebarField>

      <div className="mt-5 border-t border-[var(--border)] pt-3">
        <h2 className="mb-2 text-xs font-medium opacity-70">Activity</h2>
        <ol className="flex flex-col gap-1.5 text-xs opacity-60">
          {conversation.events.slice(0, 12).map((event) => (
            <li key={event.id}>
              <span className="font-medium">{event.actorName ?? 'System'}</span>{' '}
              {describeEvent(event.type, event.data)}
              <span className="ml-1 opacity-60">{formatRelative(event.createdAt)}</span>
            </li>
          ))}
          {conversation.events.length === 0 ? (
            <li className="opacity-50">No changes yet.</li>
          ) : null}
        </ol>
      </div>

      {/* Last, and only for an admin. Below the activity log rather than beside
          Status, because a control that deletes the page it is on should not sit
          in the same reach as the one that closes the ticket. */}
      {purgePreview ? (
        <div className="mt-5 border-t border-[var(--border)] pt-3">
          <h2 className="mb-2 text-xs font-medium opacity-70">Danger zone</h2>
          <PurgePanel
            preview={purgePreview}
            action={purgeTicket}
            idField="conversationId"
            noun="ticket"
            confirmationHint="the ticket number"
            refusal={purgeRefusal}
          />
        </div>
      ) : null}
    </aside>
  );
}

/**
 * What this ticket is about, and why it happened.
 *
 * Two blocks, because they answer different questions and are filled in at
 * different moments. The categories are what the customer said, detected on
 * arrival. The cause is what somebody established by looking, and it is asked
 * for at the end — which is why the resolve control refuses without it on a
 * ticket about a failure.
 *
 * A suggestion is shown separately from an applied category rather than styled
 * differently in the same list. An agent scanning a sidebar reads the list, not
 * the badges, and a suggestion sitting in that list is a category they will
 * assume somebody chose.
 */
function CategoriesField({
  conversation,
  options,
  rootCauses,
  canCategorise,
}: {
  conversation: ConversationDetail;
  options: CategoryOption[];
  rootCauses: RootCauseOption[];
  canCategorise: boolean;
}) {
  const applied = conversation.categories.filter(
    (category) => category.reviewState === 'auto' || category.reviewState === 'confirmed',
  );
  const suggested = conversation.categories.filter(
    (category) => category.reviewState === 'suggested',
  );
  const rejected = conversation.categories.filter(
    (category) => category.reviewState === 'rejected',
  );

  // The taxonomy has not been seeded, so the picker would be an empty dropdown
  // and every control here a dead end. Saying so beats rendering the furniture.
  const unseeded = options.length === 0 && conversation.categories.length === 0;

  return (
    <SidebarField
      label="Categories"
      hint={unseeded ? 'No taxonomy yet — run the seed to create the categories.' : undefined}
    >
      {unseeded ? null : (
        <>
          <ul className="mb-2 flex flex-col gap-1">
            {applied.map((category) => (
              <li key={category.categoryId} className="text-xs">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">
                    {category.labelEn}
                    {category.isPrimary ? (
                      <span className="ml-1 opacity-50" aria-label="primary category">
                        ★
                      </span>
                    ) : null}
                  </span>
                  {canCategorise ? (
                    <UnlinkButton
                      action={category.source === 'manual' ? removeCategory : rejectCategory}
                      fields={{
                        conversationId: conversation.id,
                        categoryId: category.categoryId,
                      }}
                      label={`Remove ${category.labelEn}`}
                    />
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className="opacity-50">{category.area}</span>
                  {category.source === 'detected' ? <Badge>auto</Badge> : null}
                  {category.source === 'manual' ? <Badge tone="brand">by hand</Badge> : null}
                </div>
              </li>
            ))}
            {applied.length === 0 ? (
              <li className="text-xs opacity-50">Nothing filed yet.</li>
            ) : null}
          </ul>

          {suggested.length > 0 ? (
            <div className="mb-2 rounded border border-dashed border-current/20 p-2">
              <p className="mb-1 flex items-center gap-1 text-xs font-medium opacity-70">
                Suggested
                <InfoTip label="suggestions">
                  Found by a keyword rule rather than read outright, so it is waiting on you.
                  Confirming one teaches us the rule was right; rejecting it stops that rule
                  suggesting the same thing again on this ticket.
                </InfoTip>
              </p>
              <ul className="flex flex-col gap-1">
                {suggested.map((category) => (
                  <li key={category.categoryId} className="text-xs">
                    <div className="flex items-start justify-between gap-1">
                      <span>{category.labelEn}</span>
                      {canCategorise ? (
                        <span className="flex shrink-0 gap-1">
                          <ReviewButton
                            action={confirmCategory}
                            conversationId={conversation.id}
                            categoryId={category.categoryId}
                            label={`Confirm ${category.labelEn}`}
                            glyph="&#10003;"
                          />
                          <ReviewButton
                            action={rejectCategory}
                            conversationId={conversation.id}
                            categoryId={category.categoryId}
                            label={`Reject ${category.labelEn}`}
                            glyph="&#215;"
                          />
                        </span>
                      ) : null}
                    </div>
                    {category.ruleKey ? (
                      <p className="opacity-50">{category.ruleKey}</p>
                    ) : (
                      <p className="opacity-50">no rule matched this message</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            Shown rather than hidden. A rejected category that simply vanished
            would invite the next agent to add it back by hand, and then nobody
            would know the rules had been wrong about it.
          */}
          {rejected.length > 0 ? (
            <p className="mb-2 text-xs opacity-40">
              Rejected: {rejected.map((category) => category.labelEn).join(', ')}
            </p>
          ) : null}

          {canCategorise && options.length > 0 ? (
            <CategoryPicker
              conversationId={conversation.id}
              options={options}
              requesterKind={conversation.requesterKind}
            />
          ) : null}

          {rootCauses.length > 0 ? (
            <RootCausePicker
              conversationId={conversation.id}
              rootCauses={rootCauses}
              value={conversation.rootCauseId}
              disabled={!canCategorise}
            />
          ) : null}
        </>
      )}
    </SidebarField>
  );
}

/** One-click confirm or reject on a suggestion. */
function ReviewButton({
  action,
  conversationId,
  categoryId,
  label,
  glyph,
}: {
  action: LinkAction;
  conversationId: string;
  categoryId: string;
  label: string;
  glyph: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('categoryId', categoryId);
    await action({ error: null }, formData);
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      onClick={() => void run()}
      className="rounded px-1 text-xs opacity-60 hover:opacity-100"
      dangerouslySetInnerHTML={{ __html: glyph }}
    />
  );
}

/**
 * Adding a category by hand.
 *
 * A select rather than the free-text input the shipment field uses, because the
 * taxonomy is a closed list: a typo cannot create a category the way a typo can
 * create a shipment stub. Grouped by area, so a list of fifty is read as twelve.
 */
function CategoryPicker({
  conversationId,
  options,
  requesterKind,
}: {
  conversationId: string;
  options: CategoryOption[];
  requesterKind: ConversationDetail['requesterKind'];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The requester's own half of the taxonomy first, everything else after it —
   * **ordered, never filtered**, and the distinction is the whole design.
   *
   * Fifty-five entries in one flat list is a list where people pick the first
   * plausible row, so putting a recipient's eleven delivery categories above a
   * merchant's payout questions is worth doing. Hiding the rest is not:
   * `requester_kind` comes off role flags that are maintained additively and
   * can be absent or stale, so a wrong one would leave an agent unable to reach
   * `billing.payout` on a merchant's ticket with no way to see why. A control
   * an agent cannot work around has to be right every time; this one cannot be.
   *
   * `any` categories — a damaged parcel is the same complaint at either end —
   * sort with the matching half rather than into the remainder.
   */
  const matches = (option: CategoryOption) =>
    requesterKind !== null && (option.audience === requesterKind || option.audience === 'any');

  const groups: { label: string; options: CategoryOption[] }[] = [];
  const byArea = (source: CategoryOption[], suffix: string) => {
    for (const area of [...new Set(source.map((option) => option.area))]) {
      groups.push({
        label: `${area}${suffix}`,
        options: source.filter((option) => option.area === area),
      });
    }
  };

  const relevant = options.filter(matches);
  if (relevant.length === 0) {
    // Nothing established about who is asking, so there is no "other" half to
    // put anything under — labelling every group that way would say the
    // opposite of what is known.
    byArea(options, '');
  } else {
    byArea(relevant, '');
    byArea(
      options.filter((option) => !matches(option)),
      ' — other',
    );
  }

  async function add(categoryId: string) {
    if (!categoryId) return;
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('categoryId', categoryId);
    const result = await addCategory({ error: null }, formData);
    setBusy(false);
    if (result.error) setError(result.error);
    else router.refresh();
  }

  return (
    <div className="mb-2">
      <select
        className="app-input w-full text-xs"
        disabled={busy}
        defaultValue=""
        aria-label="Add a category"
        onChange={(event) => {
          void add(event.target.value);
          event.target.value = '';
        }}
      >
        <option value="">Add a category…</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.labelEn}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

/**
 * Why the ticket happened.
 *
 * Grouped by who owns the fix, because that is the grouping an agent reasons in
 * — "was this us, the courier, or the merchant" — and because it makes the
 * accountability report's shape visible at the point the data is entered.
 */
function RootCausePicker({
  conversationId,
  rootCauses,
  value,
  disabled,
}: {
  conversationId: string;
  rootCauses: RootCauseOption[];
  value: string | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Held locally as well as in the prop, because a `<select>` whose value comes
   * only from the server snaps back to the old option the instant it is
   * changed and stays there until the action and the refresh both land. On a
   * `force-dynamic` page that is long enough to read as "it did not take", and
   * an agent's second attempt writes the same value twice.
   *
   * Reset to the prop whenever the server disagrees — which is how a rejected
   * write, or another agent's choice arriving on a refresh, wins.
   */
  const [chosen, setChosen] = useState<string>(value ?? '');
  const [seen, setSeen] = useState<string | null>(value);
  if (seen !== value) {
    setSeen(value);
    setChosen(value ?? '');
  }

  const owners = [...new Set(rootCauses.map((cause) => cause.owner))];

  async function save(rootCauseId: string) {
    setChosen(rootCauseId);
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('rootCauseId', rootCauseId);
    const result = await setRootCause({ error: null }, formData);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      setChosen(value ?? '');
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-3 border-t border-current/10 pt-2">
      <p className="mb-1 flex items-center gap-1 text-xs font-medium opacity-70">
        Root cause
        <InfoTip label="the root cause">
          What actually went wrong, as opposed to what the customer asked about. Recorded by you
          rather than detected, because the customer does not know it — and it is the one field the
          reports on what to go and fix are built from. Required before resolving or closing a
          ticket about a delivery, a parcel&apos;s condition, a pickup, a return or a payment.
        </InfoTip>
      </p>
      <select
        className="app-input w-full text-xs"
        disabled={disabled || busy}
        value={chosen}
        aria-label="Root cause"
        onChange={(event) => void save(event.target.value)}
      >
        <option value="">Not established yet</option>
        {owners.map((owner) => (
          <optgroup key={owner} label={owner}>
            {rootCauses
              .filter((cause) => cause.owner === owner)
              .map((cause) => (
                <option key={cause.id} value={cause.id}>
                  {cause.labelEn}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
