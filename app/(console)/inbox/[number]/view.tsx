'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChannelBadge } from '@/components/channel';
import { ChevronLeftIcon } from '@/components/icons';
import { Badge, Select } from '@/components/ui';
import { useNow } from '@/components/use-now';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/queries';
import { describeWindow, metaWindowState } from '@/lib/meta/window';
import { describeRequesterRole } from '@/lib/shipments/roles';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import {
  linkShipment,
  linkShippingAccount,
  unlinkShipment,
  unlinkShippingAccount,
  updateTicket,
} from '../../actions';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import { Composer } from './composer';

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
        <p className="mt-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
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

        <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <Timeline conversation={conversation} />
        </div>

        {readOnlyReason(conversation.channel) ? (
          <ReadOnlyNotice
            reason={readOnlyReason(conversation.channel)!}
            oneSided={!conversation.messages.some((m) => m.direction === 'outbound')}
          />
        ) : (
          <Composer conversation={conversation} templates={templates} />
        )}
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
  const isMeta = conversation.channel === 'facebook' || conversation.channel === 'instagram';
  const isComment = Boolean(conversation.externalId?.includes(':comment:'));

  return (
    <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 md:px-4">
      <div className="flex items-center gap-2">
        {/* On a phone the list and the ticket are separate screens, so the
            ticket needs a way back. */}
        <Link
          href="/inbox"
          aria-label="Back to the inbox"
          className="-ms-1 rounded-md p-1 hover:bg-[var(--muted)] md:hidden"
        >
          <ChevronLeftIcon size={18} />
        </Link>

        <h1 className="truncate text-base font-semibold">
          {conversation.subject ?? '(no subject)'}
        </h1>
        <span className="shrink-0 text-sm text-[var(--muted-foreground)]">
          #{conversation.number}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
        <Badge tone={conversation.statusCategory}>{conversation.statusName}</Badge>
        <ChannelBadge channel={conversation.channel} />
        {isComment ? <Badge tone="warning">public comment</Badge> : null}
        <span className="truncate">
          {conversation.requester.name ?? 'Unknown'}{' '}
          {conversation.requester.email ?? conversation.requester.phone ?? ''}
        </span>
        <span aria-hidden>·</span>
        <span>opened {formatRelative(conversation.createdAt)} ago</span>
        {conversation.reopenCount > 0 ? (
          <Badge tone="warning">reopened ×{conversation.reopenCount}</Badge>
        ) : null}
        {conversation.channel === 'whatsapp' ? (
          <WindowIndicator lastCustomerMessageAt={conversation.lastCustomerMessageAt} />
        ) : null}
        {isMeta && !isComment ? (
          <MetaWindowIndicator lastCustomerMessageAt={conversation.lastCustomerMessageAt} />
        ) : null}
      </div>
    </header>
  );
}

/** The Messenger and Instagram windows, in the agent's terms. */
function MetaWindowIndicator({
  lastCustomerMessageAt,
}: {
  lastCustomerMessageAt: Date | string | null;
}) {
  const now = useNow();
  if (!now) return null;

  const state = metaWindowState(
    lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null,
    now,
  );

  return (
    <Badge tone={state.isOpen ? 'open' : state.needsHumanAgentTag ? 'warning' : 'closed'}>
      {describeWindow(state)}
    </Badge>
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
        const meta = (message.meta ?? {}) as {
          metaKind?: string;
          isPublic?: boolean;
          echo?: boolean;
        };
        const isPublicComment = meta.metaKind === 'comment';

        return (
          <li
            key={message.id}
            className={`max-w-[46rem] rounded-lg border px-3.5 py-2.5 ${
              isNote
                ? 'border-amber-500/30 bg-amber-500/10'
                : isInbound
                  ? 'border-[var(--border)] bg-[var(--surface)]'
                  : 'ms-auto border-brand-500/30 bg-brand-500/8'
            }`}
          >
            <div className="mb-1.5 flex items-baseline gap-2 text-xs text-[var(--muted-foreground)]">
              <span className="font-medium">
                {/*
                  An echo has no author on either side: no agent wrote it and the
                  customer did not send it. "Automation" would be technically
                  true and useless — it was the customer bot, and on a channel
                  that mirrors two parties, saying which one matters most.
                */}
                {message.authorName ??
                  (meta.echo ? 'Customer bot' : isInbound ? 'Customer' : 'Automation')}
              </span>
              {isNote ? <Badge tone="warning">private note</Badge> : null}
              {/* Whether a reply was public is the thing an agent most needs to
                  be sure of on a social ticket, so it is stated rather than
                  implied by which column the bubble is in. */}
              {isPublicComment ? (
                <Badge tone={isInbound ? 'neutral' : 'warning'}>
                  {isInbound ? 'public comment' : 'posted publicly'}
                </Badge>
              ) : null}
              {!isInbound && !isNote && meta.metaKind === 'direct_message' ? (
                <Badge tone="neutral">direct message</Badge>
              ) : null}
              <span className="ms-auto">{formatDateTime(message.createdAt)}</span>
            </div>

            <MessageBody message={message} />

            {message.attachments.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {message.attachments.map((file) => (
                  <li
                    key={file.id}
                    className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                  >
                    <a
                      href={`/api/attachments/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {file.filename}
                    </a>
                    <span className="ms-1.5 text-[var(--muted-foreground)]">
                      {formatBytes(file.sizeBytes)}
                    </span>
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
    <p className="mt-1.5 text-xs text-[var(--muted-foreground)]/80">
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
    <aside className="app-scroll hidden w-64 shrink-0 overflow-y-auto border-s border-[var(--border)] bg-[var(--surface)] p-3 xl:block">
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

      <ShipmentsField conversation={conversation} />
      <ShippingAccountsField conversation={conversation} />

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
    case 'sla_paused':
      return 'paused the SLA clock';
    case 'sla_resumed':
      return `resumed the SLA clock after ${String(data.pausedMinutes ?? 0)} minutes`;
    case 'shipments_detected': {
      const tracking = Array.isArray(data.trackingNumbers) ? data.trackingNumbers : [];
      const sbids = Array.isArray(data.sbids) ? data.sbids : [];
      const parts = [
        tracking.length ? `shipment${tracking.length > 1 ? 's' : ''} ${tracking.join(', ')}` : null,
        sbids.length ? `account${sbids.length > 1 ? 's' : ''} ${sbids.join(', ')}` : null,
      ].filter(Boolean);
      return `linked ${parts.join(' and ')} from a message`;
    }
    case 'shipment_linked':
      return `linked shipment ${String(data.trackingNumber ?? '')}`;
    case 'shipment_unlinked':
      return `unlinked shipment ${String(data.trackingNumber ?? '')}`;
    case 'shipping_account_linked':
      return `linked account ${String(data.sbid ?? '')}`;
    case 'shipping_account_unlinked':
      return `unlinked account ${String(data.sbid ?? '')}`;
    case 'sla_recalculated':
      return data.reason === 'group_hours'
        ? "re-counted the due dates on the new group's business hours"
        : 're-counted the due dates';
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

/**
 * The parcels a ticket is about.
 *
 * An unsynced shipment says so rather than showing a row of blanks: it was
 * created from a number somebody wrote down and nothing has confirmed it exists,
 * which is a different thing from a shipment with no shipper.
 *
 * The add control is a plain input saved on Enter, matching `TagField` above.
 * This codebase has no modals, and a dialog that scrolls inside a scrolling page
 * would be the first one.
 */
function ShipmentsField({ conversation }: { conversation: ConversationDetail }) {
  return (
    <Field label="Shipments">
      <ul className="mb-2 flex flex-col gap-2">
        {conversation.shipments.map((shipment) => (
          <li key={shipment.shipmentId} className="text-xs">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/customers/shipments/${encodeURIComponent(shipment.trackingNumber)}`}
                className="font-medium break-all hover:underline"
              >
                {shipment.trackingNumber}
              </Link>
              <UnlinkButton
                action={unlinkShipment}
                fields={{
                  conversationId: conversation.id,
                  shipmentId: shipment.shipmentId,
                  trackingNumber: shipment.trackingNumber,
                }}
                label={`Unlink ${shipment.trackingNumber}`}
              />
            </div>

            <p className="mt-0.5 opacity-60">
              {shipment.syncState === 'synced'
                ? (shipment.statusLabel ?? 'No status yet')
                : shipment.syncState === 'not_found'
                  ? 'Not a shipment on the platform'
                  : 'Not synced yet'}
            </p>
            <p className="opacity-60">{describeRequesterRole(shipment.requesterRole)}</p>

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {shipment.sbid ? (
                <Link href={`/customers/accounts/${encodeURIComponent(shipment.sbid)}`}>
                  <Badge>SBID {shipment.sbid}</Badge>
                </Link>
              ) : null}
              {shipment.linkSource === 'detected' ? <Badge>auto</Badge> : null}
            </div>
          </li>
        ))}
        {conversation.shipments.length === 0 ? (
          <li className="text-xs opacity-50">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShipment}
        conversationId={conversation.id}
        name="trackingNumber"
        placeholder="Add a tracking number"
      />
    </Field>
  );
}

/**
 * SBIDs this ticket names.
 *
 * A mention, not a membership. Somebody quoting an account number in a message
 * says the number came up here; saying they belong to that account is a claim
 * about their identity and is made on the customer's own page instead.
 */
function ShippingAccountsField({ conversation }: { conversation: ConversationDetail }) {
  return (
    <Field label="Shipping accounts">
      <ul className="mb-2 flex flex-col gap-1.5">
        {conversation.shippingAccounts.map((account) => (
          <li key={account.shippingAccountId} className="flex items-center justify-between gap-2">
            <Link
              href={`/customers/accounts/${encodeURIComponent(account.sbid)}`}
              className="text-xs font-medium hover:underline"
            >
              {account.name ?? `SBID ${account.sbid}`}
            </Link>
            <div className="flex items-center gap-1">
              {account.linkSource === 'detected' ? <Badge>auto</Badge> : null}
              <UnlinkButton
                action={unlinkShippingAccount}
                fields={{
                  conversationId: conversation.id,
                  shippingAccountId: account.shippingAccountId,
                  sbid: account.sbid,
                }}
                label={`Unlink ${account.sbid}`}
              />
            </div>
          </li>
        ))}
        {conversation.shippingAccounts.length === 0 ? (
          <li className="text-xs opacity-50">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShippingAccount}
        conversationId={conversation.id}
        name="sbid"
        placeholder="Add an SBID"
      />
    </Field>
  );
}

type LinkAction = (
  state: { error: string | null },
  formData: FormData,
) => Promise<{ error: string | null }>;

function LinkInput({
  action,
  conversationId,
  name,
  placeholder,
}: {
  action: LinkAction;
  conversationId: string;
  name: string;
  placeholder: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) return;

    setSaving(true);
    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set(name, trimmed);

    const result = await action({ error: null }, formData);
    setSaving(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setError(null);
    setValue('');
    router.refresh();
  }

  return (
    <div>
      <input
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
        onBlur={() => void save()}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs outline-none focus:border-brand-500"
      />
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

/**
 * Two-click removal, inline rather than importing `DangerAction` from the admin
 * forms. Reaching into admin internals from the inbox would couple two areas
 * that have stayed apart; promoting that component into `components/ui.tsx` is
 * the better move and a wider change than this feature should carry.
 */
function UnlinkButton({
  action,
  fields,
  label,
}: {
  action: LinkAction;
  fields: Record<string, string>;
  label: string;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    await action({ error: null }, formData);
    setBusy(false);
    setArmed(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      onClick={() => (armed ? void remove() : setArmed(true))}
      onBlur={() => setArmed(false)}
      className="shrink-0 rounded px-1 text-xs opacity-50 hover:opacity-100"
    >
      {armed ? 'Sure?' : '\u00d7'}
    </button>
  );
}
