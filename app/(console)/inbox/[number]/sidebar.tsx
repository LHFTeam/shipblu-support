'use client';

import Link from 'next/link';
import { Avatar } from '@/components/avatar';
import { ChannelBadge } from '@/components/channel';
import { DetailsSection, Property, PropertyList } from '@/components/details-section';
import { formatRelative } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import type { CategoryOption, RootCauseOption } from '@/lib/categorise/queries';
import { PRIORITIES } from '@/lib/tickets/vocabulary';
import { purgeTicket } from '../../ticket-actions';
import { PurgePanel } from '../../purge-panel';
import type { PurgePreview } from '@/lib/admin/purge-summary';
import { SideConversationsField } from './side-conversations';
import { CustomFields, FieldSelect, SidebarField, TagField } from './ticket-fields';
import { ShipmentsField, ShippingAccountsField } from './shipments-field';
import { CategoriesField } from './categories-field';
import { DetailsTabs } from './details-tabs';
import { describeEvent } from '@/lib/tickets/event-labels';

/**
 * The ticket's details column: who is asking, under them three tabs.
 *
 * Tabs rather than one long column because the column is 312px and holds three
 * different questions — where the parcel is, what state the ticket is in, how
 * to reach the person — and an agent on a call asks one at a time. It opens on
 * Shipments when the ticket names a parcel or an account, since that is what
 * the customer is ringing about, and on Conversation otherwise, so a ticket
 * with nothing linked does not open on two empty lists while status and
 * assignee sit one click away.
 *
 * From `lg` only, as the thread beside it needs the rest of a laptop's width;
 * below that the header carries who is asking and the composer carries the
 * knowledge base, so nothing an agent needs to answer lives only here.
 */
export function Sidebar({
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
  canViewContact,
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
  /** Whether the Contact tab may link to the contact's page, which refuses everybody else. */
  canViewContact: boolean;
}) {
  const { requester } = conversation;
  const linked = conversation.shipments.length + conversation.shippingAccounts.length > 0;

  const properties = (
    <DetailsSection collapsible={false}>
      <div className="grid gap-3">
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
            label="Status"
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
            label="Assignee"
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
            label="Group"
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
            label="Priority"
            value={conversation.priority}
            options={PRIORITIES.map((p) => ({ value: p, label: p }))}
          />
        </SidebarField>

        <SidebarField label="Tags">
          <TagField conversationId={conversation.id} tags={conversation.tags} />
        </SidebarField>

        <CustomFields conversation={conversation} fields={fields} />
      </div>
    </DetailsSection>
  );

  return (
    <aside
      aria-label="Ticket details"
      className="app-scroll hidden w-(--details-width) shrink-0 overflow-y-auto rounded-(--console-panel-radius) bg-(--color-background-surface) lg:block"
    >
      <div className="flex items-center gap-3 px-(--density-row-x) pt-[18px] pb-4">
        <Avatar
          name={requester.name}
          contactId={requester.id}
          hasAvatar={requester.hasAvatar}
          size={48}
        />
        <div className="min-w-0">
          <p dir="auto" className="truncate text-base font-semibold text-(--color-text-primary)">
            {requester.name ?? 'Unknown'}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <ChannelBadge channel={conversation.channel} />
          </p>
        </div>
      </div>

      <DetailsTabs
        initial={linked ? 'shipments' : 'conversation'}
        tabs={[
          {
            id: 'shipments',
            label: 'Shipments',
            panel: (
              <>
                <ShipmentsField conversation={conversation} />
                <ShippingAccountsField conversation={conversation} />
              </>
            ),
          },
          {
            id: 'conversation',
            label: 'Conversation',
            panel: (
              <>
                {properties}

                <CategoriesField
                  conversation={conversation}
                  options={categoryOptions}
                  rootCauses={rootCauses}
                  canCategorise={canCategorise}
                />

                <DetailsSection
                  collapsible={false}
                  title={`Side conversations · ${conversation.sideConversations.length}`}
                >
                  <SideConversationsField sides={conversation.sideConversations} />
                </DetailsSection>

                <DetailsSection
                  collapsible={false}
                  variant={purgePreview ? 'plain' : 'flush'}
                  title="Activity"
                >
                  <ol className="flex flex-col gap-1.5 text-xs text-(--color-text-secondary)">
                    {conversation.events.slice(0, 12).map((event) => (
                      <li key={event.id}>
                        <span className="font-medium text-(--color-text-primary)">
                          {event.actorName ?? 'System'}
                        </span>{' '}
                        {describeEvent(event.type, event.data)}
                        <span className="ms-1 text-(--color-text-tertiary)">
                          {formatRelative(event.createdAt)}
                        </span>
                      </li>
                    ))}
                    {conversation.events.length === 0 ? (
                      <li className="text-(--color-text-tertiary)">No changes yet.</li>
                    ) : null}
                  </ol>
                </DetailsSection>

                {/* Last, and only for an admin. Below the activity log rather than beside
                    Status, because a control that deletes the page it is on should not sit
                    in the same reach as the one that closes the ticket. */}
                {purgePreview ? (
                  <DetailsSection collapsible={false} variant="flush" title="Danger zone">
                    <PurgePanel
                      preview={purgePreview}
                      action={purgeTicket}
                      idField="conversationId"
                      noun="ticket"
                      confirmationHint="the ticket number"
                      refusal={purgeRefusal}
                    />
                  </DetailsSection>
                ) : null}
              </>
            ),
          },
          {
            id: 'contact',
            label: 'Contact',
            panel: (
              <DetailsSection collapsible={false} variant="flush" title="Contact">
                {requester.email || requester.phone ? (
                  <PropertyList>
                    <Property label="Email" value={requester.email} ltr />
                    <Property label="Phone" value={requester.phone} ltr />
                  </PropertyList>
                ) : (
                  <p className="text-sm text-(--color-text-tertiary)">
                    No email address or phone number on file.
                  </p>
                )}
                {/* Only for an agent the contact page would let in: a link to a
                    refusal is a dead end that looks like a bug. */}
                {canViewContact ? (
                  <Link
                    href={`/contacts/${requester.id}`}
                    className="mt-3 inline-block text-xs text-(--color-text-link) hover:underline"
                  >
                    Open contact
                  </Link>
                ) : null}
              </DetailsSection>
            ),
          },
        ]}
      />
    </aside>
  );
}
