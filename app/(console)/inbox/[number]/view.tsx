'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Select } from '@/components/ui';
import { useNow } from '@/components/use-now';
import { channelLabel, formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/queries';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import { updateTicket } from '../../actions';
import { Composer } from './composer';

export type TemplateOption = {
  id: string;
  name: string;
  language: string;
  category: string;
  components: unknown[];
};

export function ConversationView({
  conversation,
  statuses,
  agents,
  groups,
  templates,
  currentAgentId,
}: {
  conversation: ConversationDetail;
  statuses: { id: string; name: string; category: string }[];
  agents: { id: string; name: string; email: string }[];
  groups: { id: string; name: string }[];
  templates: TemplateOption[];
  currentAgentId: string;
}) {
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header conversation={conversation} />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <Timeline conversation={conversation} />
        </div>

        <Composer conversation={conversation} templates={templates} />
      </div>

      <Sidebar
        conversation={conversation}
        statuses={statuses}
        agents={agents}
        groups={groups}
        currentAgentId={currentAgentId}
      />
    </div>
  );
}

function Header({ conversation }: { conversation: ConversationDetail }) {
  return (
    <header className="shrink-0 border-b border-[var(--border)] px-4 py-3">
      <div className="flex items-baseline gap-2">
        <h1 className="truncate text-base font-semibold">
          {conversation.subject ?? '(no subject)'}
        </h1>
        <span className="shrink-0 text-sm opacity-50">#{conversation.number}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs opacity-70">
        <Badge tone={conversation.statusCategory}>{conversation.statusName}</Badge>
        <span>{channelLabel(conversation.channel)}</span>
        <span>·</span>
        <span>
          {conversation.requester.name ?? 'Unknown'}{' '}
          <span className="opacity-60">
            {conversation.requester.email ?? conversation.requester.phone ?? ''}
          </span>
        </span>
        <span>·</span>
        <span>opened {formatRelative(conversation.createdAt)} ago</span>
        {conversation.reopenCount > 0 ? (
          <Badge tone="warning">reopened ×{conversation.reopenCount}</Badge>
        ) : null}
        {conversation.channel === 'whatsapp' ? (
          <WindowIndicator lastCustomerMessageAt={conversation.lastCustomerMessageAt} />
        ) : null}
      </div>
    </header>
  );
}

/**
 * Live countdown, ticking client-side.
 *
 * A window that silently expires while an agent is composing is the single
 * worst WhatsApp failure mode, so the number has to move rather than reflect
 * whenever the page last rendered.
 */
function WindowIndicator({
  lastCustomerMessageAt,
}: {
  lastCustomerMessageAt: Date | string | null;
}) {
  const last = lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null;
  const now = useNow();

  // Null until mounted. Rendering nothing for that first pass is deliberate:
  // a countdown computed on the server would be wrong by the time it arrived.
  if (!now) return null;

  const state = windowState(last, now);

  return state.isOpen ? (
    <Badge tone={state.remainingMs < 2 * 60 * 60 * 1000 ? 'warning' : 'open'}>
      window {formatRemaining(state.remainingMs)}
    </Badge>
  ) : (
    <Badge tone="closed">window closed — template only</Badge>
  );
}

function Timeline({ conversation }: { conversation: ConversationDetail }) {
  return (
    <ol className="flex flex-col gap-4">
      {conversation.messages.map((message) => {
        const isNote = message.kind === 'note';
        const isInbound = message.direction === 'inbound';

        return (
          <li
            key={message.id}
            className={`max-w-[46rem] rounded-lg border px-3.5 py-2.5 ${
              isNote
                ? 'border-amber-500/30 bg-amber-500/10'
                : isInbound
                  ? 'border-[var(--border)] bg-[var(--muted)]'
                  : 'ml-auto border-brand-500/30 bg-brand-500/5'
            }`}
          >
            <div className="mb-1.5 flex items-baseline gap-2 text-xs opacity-60">
              <span className="font-medium">{message.authorName ?? 'Unknown'}</span>
              {isNote ? <Badge tone="warning">private note</Badge> : null}
              <span className="ml-auto">{formatDateTime(message.createdAt)}</span>
            </div>

            <MessageBody message={message} />

            {message.attachments.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {message.attachments.map((file) => (
                  <li
                    key={file.id}
                    className="rounded border border-[var(--border)] px-2 py-1 text-xs"
                  >
                    <a href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer">
                      {file.filename}
                    </a>
                    <span className="ml-1.5 opacity-50">{formatBytes(file.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {!isInbound && !isNote ? <DeliveryState message={message} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function MessageBody({ message }: { message: ConversationDetail['messages'][number] }) {
  if (message.bodyHtml) {
    // Sanitised at ingest and again on compose, never here: doing it at write
    // time means the stored row is safe for every consumer, not just this one.
    return (
      <div
        className="prose-sm max-w-none text-sm [&_a]:text-brand-600 [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
      />
    );
  }

  const media = (message.meta as { media?: { downloaded?: boolean; error?: string } }).media;

  return (
    <>
      <p className="whitespace-pre-wrap text-sm">{message.bodyText}</p>
      {media && !media.downloaded ? (
        <p className="mt-1 text-xs opacity-50">
          {media.error ? `Attachment unavailable: ${media.error}` : 'Downloading attachment…'}
        </p>
      ) : null}
    </>
  );
}

function DeliveryState({ message }: { message: ConversationDetail['messages'][number] }) {
  if (message.deliveryStatus === 'failed') {
    return (
      <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
        Not delivered — {message.deliveryError ?? 'unknown error'}
      </p>
    );
  }

  return (
    <p className="mt-1.5 text-xs opacity-40">
      {message.deliveryStatus === 'pending' ? 'sending…' : message.deliveryStatus}
    </p>
  );
}

function Sidebar({
  conversation,
  statuses,
  agents,
  groups,
  currentAgentId,
}: {
  conversation: ConversationDetail;
  statuses: { id: string; name: string; category: string }[];
  agents: { id: string; name: string; email: string }[];
  groups: { id: string; name: string }[];
  currentAgentId: string;
}) {
  return (
    <aside className="w-64 shrink-0 overflow-y-auto border-l border-[var(--border)] p-3">
      <Field label="Status">
        <FieldSelect
          conversationId={conversation.id}
          field="status"
          value={conversation.statusId}
          options={statuses.map((s) => ({ value: s.id, label: s.name }))}
        />
      </Field>

      <Field label="Assignee">
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
      </Field>

      <Field label="Group">
        <FieldSelect
          conversationId={conversation.id}
          field="group"
          value={conversation.groupId ?? ''}
          options={[
            { value: '', label: 'None' },
            ...groups.map((g) => ({ value: g.id, label: g.name })),
          ]}
        />
      </Field>

      <Field label="Priority">
        <FieldSelect
          conversationId={conversation.id}
          field="priority"
          value={conversation.priority}
          options={['low', 'medium', 'high', 'urgent'].map((p) => ({ value: p, label: p }))}
        />
      </Field>

      <Field label="Tags">
        <TagField conversationId={conversation.id} tags={conversation.tags} />
      </Field>

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
    </aside>
  );
}

function describeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'status_changed':
      return `set status to ${String(data.to ?? '')}`;
    case 'priority_changed':
      return `set priority to ${String(data.to ?? '')}`;
    case 'assigned':
      return 'reassigned the ticket';
    case 'unassigned':
      return 'unassigned the ticket';
    case 'reopened':
      return 'reopened the ticket';
    default:
      return type.replace(/_/g, ' ');
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-xs font-medium opacity-60">{label}</p>
      {children}
    </div>
  );
}

/**
 * Saves on change with no explicit save button, matching Freshdesk. The router
 * refresh re-reads the server components so the timeline picks up the audit
 * entry the action just wrote.
 */
function FieldSelect({
  conversationId,
  field,
  value,
  options,
}: {
  conversationId: string;
  field: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string) {
    setSaving(true);
    setError(null);

    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('field', field);
    formData.set('value', next);

    const result = await updateTicket({ error: null }, formData);
    setSaving(false);

    if (result.error) setError(result.error);
    else router.refresh();
  }

  return (
    <>
      <Select value={value} disabled={saving} onChange={(e) => save(e.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </>
  );
}

function TagField({ conversationId, tags }: { conversationId: string; tags: string[] }) {
  const router = useRouter();
  const [value, setValue] = useState(tags.join(', '));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (value === tags.join(', ')) return;
    setSaving(true);

    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('field', 'tags');
    formData.set('value', value);

    await updateTicket({ error: null }, formData);
    setSaving(false);
    router.refresh();
  }

  return (
    <input
      value={value}
      disabled={saving}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      placeholder="comma, separated"
      className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:border-brand-500"
    />
  );
}
