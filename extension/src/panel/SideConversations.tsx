import { useState, type FormEvent } from 'react';
import { HubIcon, PlusIcon } from '@/components/icons';
import { RelativeTime } from '@/components/relative-time';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  Select,
  Textarea,
} from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import {
  blankSideSubject,
  describeRecipient,
  subjectPrefill,
  trackingPrefill,
} from '@/lib/side-conversations/format';
import {
  listRecipients,
  listShipments,
  listSideConversations,
  replyToSideConversation,
  setSideConversationState,
  startSideConversation,
  type Recipient,
  type SideConversation,
} from './api';
import { usePolled, useWrite } from './hooks';

/**
 * The ticket's side conversations, and the composer to start one.
 *
 * Every write goes to the route that calls `lib/side-conversations/write.ts`,
 * the same function as the console's composer, so who may receive one — never
 * the customer — is decided there, not here. What this file keeps from the
 * console's composer is how it is filled in: nobody preselected, the tracking
 * number written in for the agent, and "Set to Pending" on by default.
 */
export function SideConversationsTab({
  ticketId,
  ticketSubject,
}: {
  ticketId: string;
  ticketSubject: string | null;
}) {
  const sides = usePolled(`sides:${ticketId}`, () => listSideConversations(ticketId));
  const [composing, setComposing] = useState(false);

  if (sides.loading) {
    return <p className="text-sm text-(--color-text-secondary)">Loading side conversations…</p>;
  }
  if (!sides.data) return <ErrorText>{sides.error?.message ?? null}</ErrorText>;

  const { canWrite, sideConversations } = sides.data;

  return (
    <div className="flex flex-col gap-3">
      {sides.error ? <ErrorText inline>{sides.error.message}</ErrorText> : null}

      {canWrite && !composing ? (
        <Button
          variant="secondary"
          icon={<PlusIcon size={14} />}
          onClick={() => setComposing(true)}
        >
          New side conversation
        </Button>
      ) : null}

      {canWrite && composing ? (
        <Composer
          ticketId={ticketId}
          ticketSubject={ticketSubject}
          onCancel={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            sides.reload();
          }}
        />
      ) : null}

      {sideConversations.length === 0 && !composing ? (
        <EmptyState
          title="No side conversations"
          hint="Ask a hub, a team or a vendor about this ticket without the customer seeing it."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {sideConversations.map((side) => (
            <Thread key={side.id} side={side} canWrite={canWrite} onChanged={sides.reload} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The thread's state in words, as the console's card says it. */
function SideState({ side }: { side: SideConversation }) {
  if (side.state === 'done') return <Badge tone="resolved">Done</Badge>;
  if (side.awaitingReply) {
    return (
      <Badge tone="hub-waiting">
        Awaiting reply
        <RelativeTime at={side.lastMessageAt}>{(relative) => ` · ${relative}`}</RelativeTime>
      </Badge>
    );
  }
  return <Badge tone="hub-replied">Replied</Badge>;
}

function Thread({
  side,
  canWrite,
  onChanged,
}: {
  side: SideConversation;
  canWrite: boolean;
  onChanged: () => void;
}) {
  // Open when somebody is waiting on us to read it, as in the console.
  const [open, setOpen] = useState(side.state === 'open' && !side.awaitingReply);
  const last = side.messages[side.messages.length - 1];

  return (
    <li className="overflow-hidden rounded-xl border border-(--color-border-default) bg-(--color-background-surface)">
      <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border-subtle) bg-(--color-background-surface-sunken) px-3 py-2 text-xs">
        <HubIcon size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-semibold">{describeRecipient(side)}</span>
        <SideState side={side} />
      </div>

      <p dir="auto" className="px-3 pt-2 text-start text-sm font-medium">
        {side.subject}
      </p>

      {!open ? (
        <div className="px-3 pt-1 pb-2.5">
          {last ? (
            <p dir="auto" className="line-clamp-2 text-start text-xs text-(--color-text-secondary)">
              <span className="font-medium text-(--color-text-primary)">
                {last.direction === 'inbound' ? (last.authorName ?? 'They') : 'We'} said:
              </span>{' '}
              {last.bodyText}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1 text-xs font-medium text-(--color-text-link) hover:underline"
          >
            Open thread ({side.messages.length})
          </button>
        </div>
      ) : (
        <div className="pb-2.5">
          <ol className="px-3 py-1">
            {side.messages.map((message) => (
              <li
                key={message.id}
                className="border-t border-(--color-border-subtle) py-2 first:border-t-0"
              >
                {/* An out-of-office is not the hub's answer: dimmed, not hidden. */}
                <div className={message.isAutomated ? 'opacity-60' : undefined}>
                  <div className="flex items-baseline gap-2 text-xs text-(--color-text-secondary)">
                    <span className="font-semibold text-(--color-text-primary)">
                      {message.authorName ?? (message.direction === 'inbound' ? 'They' : 'We')}
                    </span>
                    {message.isAutomated ? <Badge tone="automated">Auto-reply</Badge> : null}
                    <span className="ms-auto shrink-0">{formatDateTime(message.createdAt)}</span>
                  </div>
                  {/* The text, not the HTML: a hub's email is sanitised on
                      write, but the panel has no need of its markup, and the
                      text cannot render anything but text. */}
                  <p dir="auto" className="mt-1 text-start text-sm/5 whitespace-pre-wrap">
                    {message.bodyText}
                  </p>
                </div>
                {message.attachments.length > 0 ? (
                  <p className="mt-1 text-xs text-(--color-text-tertiary)">
                    {message.attachments.length === 1
                      ? '1 attachment — open the ticket in the console to see it'
                      : `${message.attachments.length} attachments — open the ticket in the console to see them`}
                  </p>
                ) : null}
                {message.direction === 'outbound' && message.deliveryStatus === 'failed' ? (
                  <p className="mt-1 text-xs text-(--color-feedback-danger-fg)">
                    Not delivered — {message.deliveryError ?? 'unknown error'}
                  </p>
                ) : message.direction === 'outbound' && message.deliveryStatus === 'pending' ? (
                  <p className="mt-1 text-xs text-(--color-text-tertiary)">sending…</p>
                ) : null}
              </li>
            ))}
          </ol>

          {canWrite ? <Reply side={side} onSent={onChanged} /> : null}

          <div className="mt-2 flex items-center gap-2 px-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Collapse
            </Button>
            {canWrite ? <StateButton side={side} onChanged={onChanged} /> : null}
          </div>
        </div>
      )}
    </li>
  );
}

function Reply({ side, onSent }: { side: SideConversation; onSent: () => void }) {
  const [body, setBody] = useState('');
  const write = useWrite();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await write.run(() => replyToSideConversation(side.id, body))) {
      setBody('');
      onSent();
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 px-3 pt-1">
      <Textarea
        rows={3}
        required
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={`Reply to ${describeRecipient(side)}…`}
        aria-label="Reply"
      />
      <ErrorText>{write.error}</ErrorText>
      <Button
        type="submit"
        size="sm"
        className="self-end"
        disabled={write.busy}
        loading={write.busy}
      >
        {write.busy ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}

function StateButton({ side, onChanged }: { side: SideConversation; onChanged: () => void }) {
  const write = useWrite();
  const next = side.state === 'done' ? 'open' : 'done';

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={write.busy}
        loading={write.busy}
        onClick={() => {
          void write
            .run(() => setSideConversationState(side.id, next))
            .then((ok) => ok && onChanged());
        }}
      >
        {next === 'done' ? 'Mark done' : 'Reopen'}
      </Button>
      {write.error ? <ErrorText inline>{write.error}</ErrorText> : null}
    </>
  );
}

// Hubs first: they are what a late parcel is almost always about.
const GROUPS: { kind: Recipient['kind']; label: string }[] = [
  { kind: 'hub', label: 'Hubs and warehouses' },
  { kind: 'team', label: 'Internal teams' },
  { kind: 'vendor', label: 'Vendors' },
];

function Composer({
  ticketId,
  ticketSubject,
  onCancel,
  onSent,
}: {
  ticketId: string;
  ticketSubject: string | null;
  onCancel: () => void;
  onSent: () => void;
}) {
  const recipients = usePolled('recipients', listRecipients, 5 * 60_000);
  const parcels = usePolled(`shipments:${ticketId}`, () => listShipments(ticketId));

  if (recipients.loading || parcels.loading) {
    return <p className="text-sm text-(--color-text-secondary)">Loading…</p>;
  }
  if (!recipients.data) return <ErrorText>{recipients.error?.message ?? null}</ErrorText>;

  const trackingNumbers = (parcels.data ?? []).map((shipment) => shipment.trackingNumber);

  return (
    <Draft
      ticketId={ticketId}
      ticketSubject={ticketSubject}
      recipients={recipients.data}
      trackingNumbers={trackingNumbers}
      onCancel={onCancel}
      onSent={onSent}
    />
  );
}

/**
 * The form, mounted once its directory and parcels are loaded, so the
 * prefilled subject and body are its starting values rather than text that
 * arrives under an agent who has started typing.
 */
function Draft({
  ticketId,
  ticketSubject,
  recipients,
  trackingNumbers,
  onCancel,
  onSent,
}: {
  ticketId: string;
  ticketSubject: string | null;
  recipients: Recipient[];
  trackingNumbers: string[];
  onCancel: () => void;
  onSent: () => void;
}) {
  // Nobody preselected, for the console's reason: an agent who sent without
  // touching the picker would ask whichever hub sorts first about a parcel it
  // may never have seen, carrying the customer's name and address.
  const [recipientId, setRecipientId] = useState(recipients.length > 0 ? '' : 'other');
  const [toAddress, setToAddress] = useState('');
  const [ccAddresses, setCcAddresses] = useState('');
  const [subject, setSubject] = useState(() => subjectPrefill(trackingNumbers));
  // The tracking number written in: a transposed digit sends a hub looking for
  // somebody else's parcel.
  const [body, setBody] = useState(() => trackingPrefill(trackingNumbers));
  const [setPending, setSetPending] = useState(true);
  const write = useWrite();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const sent = await write.run(() =>
      startSideConversation(ticketId, {
        recipientId,
        toAddress: recipientId === 'other' ? toAddress : '',
        ccAddresses: recipientId === 'other' ? ccAddresses : '',
        subject,
        body,
        setPending,
      }),
    );
    if (sent) onSent();
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-lg border border-(--color-border-default) bg-(--color-background-surface) p-3"
    >
      {recipients.length === 0 ? (
        <Notice tone="warning" icon>
          No hubs or teams have been entered yet. Type an address, or ask an admin to add them under
          Settings → Locations and Internal recipients.
        </Notice>
      ) : null}

      <Field label="Ask">
        <Select
          required
          value={recipientId}
          onChange={(event) => setRecipientId(event.target.value)}
        >
          {recipients.length > 0 || recipientId !== 'other' ? (
            <option value="">Choose…</option>
          ) : null}
          {GROUPS.map(({ kind, label }) => {
            const entries = recipients.filter((entry) => entry.kind === kind);
            if (entries.length === 0) return null;
            return (
              <optgroup key={kind} label={label}>
                {entries.map((entry) => (
                  <option key={`${entry.source}:${entry.id}`} value={`${entry.source}:${entry.id}`}>
                    {entry.hint && entry.kind === 'hub'
                      ? `${entry.name} (${entry.hint})`
                      : entry.name}
                  </option>
                ))}
              </optgroup>
            );
          })}
          <option value="other">Someone else…</option>
        </Select>
      </Field>

      {recipientId === 'other' ? (
        <>
          <Field label="Email address">
            <Input
              type="email"
              required
              value={toAddress}
              onChange={(event) => setToAddress(event.target.value)}
              placeholder="name@shipblu.com"
            />
          </Field>
          <Field label="CC (optional)">
            <Input
              value={ccAddresses}
              onChange={(event) => setCcAddresses(event.target.value)}
              placeholder="comma, separated"
            />
          </Field>
        </>
      ) : null}

      <Field label="Subject">
        <Input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder={blankSideSubject(ticketSubject)}
        />
      </Field>

      <Textarea
        rows={5}
        required
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Ask the hub what is actually happening with this parcel…"
        aria-label="Question"
      />

      <label className="flex items-center gap-1.5 text-xs text-(--color-text-secondary)">
        <input
          type="checkbox"
          checked={setPending}
          onChange={(event) => setSetPending(event.target.checked)}
          className="size-4 shrink-0 accent-(--color-control-accent)"
        />
        Set this ticket to Pending
      </label>

      <ErrorText>{write.error}</ErrorText>

      <div className="flex items-center gap-2">
        <span className="text-2xs text-(--color-text-secondary)">Not visible to the customer</span>
        <Button variant="ghost" size="sm" className="ms-auto" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={write.busy} loading={write.busy}>
          {write.busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
