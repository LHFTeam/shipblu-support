'use client';

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
import { describeEvent } from '@/lib/tickets/event-labels';

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
