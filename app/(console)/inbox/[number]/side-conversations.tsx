'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, ErrorText, Input, Label, Select, Textarea } from '@/components/ui';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import type { PickerEntry, SideConversationView } from '@/lib/side-conversations/queries';
import { describeRecipient, trackingPrefill } from '@/lib/side-conversations/format';
import type { ConversationDetail } from '@/lib/tickets/queries';
import {
  replyToSideConversation,
  setSideConversationState,
  startSideConversation,
  type ActionState,
} from '../../actions';

const INITIAL: ActionState = { error: null };

/**
 * Side conversations in the agent console.
 *
 * Two vendors have converged on complementary halves of this and both are here.
 * Freshworks puts a thread **inline in the ticket**, which is what preserves the
 * only chronology that matters — the customer complained, we asked the hub, the
 * hub answered, we replied. Zendesk keeps a **list with an open/done state**,
 * which is what stops a thread nobody closed disappearing into a long ticket.
 * So: a card in the timeline, and an index in the sidebar.
 *
 * Everything expands in place. This codebase has no modals — see the note on
 * `ShipmentsField` in `view.tsx` — and a dialog that scrolls inside a scrolling
 * page would be the first one.
 *
 * ## Violet, and said out loud
 *
 * Amber is already the private note. A side conversation is a *third* kind of
 * writing on a ticket the customer cannot see, and the failure mode of confusing
 * it with the reply box is the worst one this feature has: an internal question
 * about a customer, sent to that customer. So the colour is different from both,
 * and every card and every input says "not visible to the customer" in words.
 * That label is load-bearing, not decoration.
 */

const PANEL = 'border-violet-500/30 bg-violet-500/8 dark:bg-violet-400/8';

function SideIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5 shrink-0"
    >
      <path d="M17 3 21 7l-4 4" />
      <path d="M21 7H8a4 4 0 0 0-4 4v1" />
      <path d="M7 21 3 17l4-4" />
      <path d="M3 17h13a4 4 0 0 0 4-4v-1" />
    </svg>
  );
}

/** Said on every surface an agent can type into. */
function NotVisible() {
  return (
    <span className="text-[11px] text-violet-700/80 dark:text-violet-300/80">
      Not visible to the customer
    </span>
  );
}

export function SideConversationCard({
  side,
  canWrite,
}: {
  side: SideConversationView;
  canWrite: boolean;
}) {
  // Collapsed by default except when somebody is waiting on us to read it. An
  // answer that arrived and has not been acted on is the whole reason to look at
  // this ticket, so it does not hide behind a disclosure triangle.
  const [open, setOpen] = useState(side.state === 'open' && !side.awaitingReply);

  const last = side.messages[side.messages.length - 1];
  const count = side.messages.length;

  return (
    <li
      id={`side-${side.number}`}
      className={`max-w-[46rem] scroll-mt-4 rounded-lg border ${PANEL} px-3.5 py-2.5`}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-xs text-[var(--muted-foreground)]">
        <span className="flex items-center gap-1.5 font-medium text-violet-800 dark:text-violet-200">
          <SideIcon />
          Side conversation
        </span>
        <span className="font-medium">{describeRecipient(side)}</span>
        {side.state === 'done' ? (
          <Badge tone="resolved">done</Badge>
        ) : side.awaitingReply ? (
          <Badge tone="warning">awaiting reply · {formatRelative(side.lastMessageAt)}</Badge>
        ) : (
          <Badge tone="open">replied</Badge>
        )}
        <NotVisible />
        <span className="ms-auto">{formatDateTime(side.createdAt)}</span>
      </div>

      <p className="mt-1.5 text-sm font-medium">{side.subject}</p>

      {!open ? (
        <div className="mt-1.5">
          {last ? (
            <p className="line-clamp-2 text-sm opacity-70">
              <span className="font-medium">
                {last.direction === 'inbound' ? (last.authorName ?? 'They') : 'We'} said:
              </span>{' '}
              {last.bodyText}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1.5 text-xs font-medium text-violet-700 hover:underline dark:text-violet-300"
          >
            Open thread ({count} {count === 1 ? 'message' : 'messages'})
          </button>
        </div>
      ) : (
        <div className="mt-2">
          <ol className="flex flex-col gap-2">
            {side.messages.map((message) => (
              <li
                key={message.id}
                className={`rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 ${
                  // An out-of-office is not the hub's answer. Dimmed rather than
                  // hidden: "we heard back but only from a robot" is information.
                  message.isAutomated ? 'opacity-60' : ''
                } ${message.direction === 'outbound' ? 'ms-6' : 'me-6'}`}
              >
                <div className="mb-1 flex items-baseline gap-2 text-xs text-[var(--muted-foreground)]">
                  <span className="font-medium">
                    {message.authorName ?? (message.direction === 'inbound' ? 'They' : 'We')}
                  </span>
                  {message.isAutomated ? <Badge>auto-reply</Badge> : null}
                  <span className="ms-auto">{formatDateTime(message.createdAt)}</span>
                </div>

                {message.bodyHtml ? (
                  <div
                    className="prose-sm max-w-none text-sm [&_a]:text-brand-600 [&_a]:underline"
                    dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
                  />
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{message.bodyText}</p>
                )}

                {message.attachments.length > 0 ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {message.attachments.map((file) => (
                      <li
                        key={file.id}
                        className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs"
                      >
                        <a
                          href={`/api/attachments/${file.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          {file.filename}
                        </a>
                        <span className="ms-1 opacity-60">{formatBytes(file.sizeBytes)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {message.direction === 'outbound' && message.deliveryStatus === 'failed' ? (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    Not delivered — {message.deliveryError ?? 'unknown error'}
                  </p>
                ) : message.direction === 'outbound' && message.deliveryStatus === 'pending' ? (
                  <p className="mt-1 text-xs opacity-50">sending…</p>
                ) : null}
              </li>
            ))}
          </ol>

          {canWrite ? <SideReplyForm side={side} /> : null}

          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs opacity-60 hover:opacity-100"
            >
              Collapse
            </button>
            {canWrite ? <StateButton side={side} /> : null}
          </div>
        </div>
      )}
    </li>
  );
}

function SideReplyForm({ side }: { side: SideConversationView }) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(INITIAL);
  const [busy, setBusy] = useState(false);

  async function submit(formData: FormData) {
    setBusy(true);
    const result = await replyToSideConversation(INITIAL, formData);
    setBusy(false);
    setState(result);
    if (result.ok) router.refresh();
  }

  return (
    <form key={state.nonce ?? 0} action={submit} className="mt-2 flex flex-col gap-1.5">
      <input type="hidden" name="sideConversationId" value={side.id} />
      <Textarea
        name="body"
        rows={2}
        required
        placeholder={`Write back to ${describeRecipient(side)}…`}
        className="border-violet-500/40 bg-[var(--surface)]"
      />
      <ErrorText>{state.error}</ErrorText>
      <div className="flex items-center gap-2">
        <NotVisible />
        <Button type="submit" disabled={busy} className="ms-auto">
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}

function StateButton({ side }: { side: SideConversationView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const formData = new FormData();
    formData.set('sideConversationId', side.id);
    formData.set('state', side.state === 'open' ? 'done' : 'open');
    await setSideConversationState(INITIAL, formData);
    setBusy(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void toggle()}
      className="ms-auto text-xs font-medium text-violet-700 hover:underline disabled:opacity-50 dark:text-violet-300"
    >
      {side.state === 'open' ? 'Mark done' : 'Reopen'}
    </button>
  );
}

/**
 * Starting a thread, from the composer's fourth tab.
 *
 * The recipient is a picker rather than a text box, and that is the difference
 * between a typo being a nuisance and a typo being a data leak:
 * `hub-downton@shipblu.com` reaches whoever registered that domain, carrying a
 * customer's address and their parcel history. "Someone else" is still there for
 * the genuinely ad-hoc case, and the server refuses the customer's own addresses
 * whichever route the address came in by.
 *
 * One list over two registers. Hubs are `locations` rows — the register of
 * places ShipBlu works out of, which already existed — and everything that is
 * not a place comes from `internal_recipients`. An agent should not have to know
 * which table a name lives in, so the only trace of the split is the group
 * heading and the code shown beside a hub, which is what people actually say to
 * each other: "CAI-1", not "the one in Maadi".
 */
export function StartSideConversationForm({
  conversation,
  recipients,
  onSent,
}: {
  conversation: ConversationDetail;
  recipients: PickerEntry[];
  /** Lets the composer put itself away on a phone once the thread is started. */
  onSent?: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [recipientId, setRecipientId] = useState(
    recipients[0] ? `${recipients[0].source}:${recipients[0].id}` : 'other',
  );

  // The last thing the customer actually said. Both the anchor the thread hangs
  // off and, optionally, the text quoted into the question.
  const anchor = [...conversation.messages]
    .reverse()
    .find((message) => message.direction === 'inbound' && message.kind !== 'note');

  const trackingNumbers = conversation.shipments.map((shipment) => shipment.trackingNumber);

  async function submit(formData: FormData) {
    setBusy(true);
    const result = await startSideConversation(INITIAL, formData);
    setBusy(false);
    setState(result);
    if (result.ok) {
      router.refresh();
      onSent?.();
    }
  }

  // Hubs first: they are what a late parcel is almost always about, and the
  // sixteen of them dwarf the handful of teams and vendors.
  const GROUPS: { kind: PickerEntry['kind']; label: string }[] = [
    { kind: 'hub', label: 'Hubs and warehouses' },
    { kind: 'team', label: 'Internal teams' },
    { kind: 'vendor', label: 'Vendors' },
  ];

  return (
    <form key={state.nonce ?? 0} action={submit} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversation.id} />
      <input type="hidden" name="anchorMessageId" value={anchor?.id ?? ''} />

      {recipients.length === 0 ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          No hubs or teams have been entered yet, so there is nobody to pick. Add ShipBlu&apos;s
          locations under <span className="font-medium">Settings → Locations</span>, and anyone who
          is not a location under <span className="font-medium">Internal recipients</span>. Until
          then you can still type an address by hand.
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor="recipientId">Ask</Label>
          <Select
            id="recipientId"
            name="recipientId"
            value={recipientId}
            onChange={(event) => setRecipientId(event.target.value)}
          >
            {GROUPS.map(({ kind, label }) => {
              const entries = recipients.filter((entry) => entry.kind === kind);
              if (entries.length === 0) return null;

              return (
                <optgroup key={kind} label={label}>
                  {entries.map((entry) => (
                    <option
                      key={`${entry.source}:${entry.id}`}
                      value={`${entry.source}:${entry.id}`}
                    >
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
        </div>

        <div>
          <Label htmlFor="subject">Subject</Label>
          <Input
            id="subject"
            name="subject"
            defaultValue={conversation.subject ?? ''}
            placeholder="What this is about"
          />
        </div>
      </div>

      {recipientId === 'other' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <Label htmlFor="toAddress">Email address</Label>
            <Input id="toAddress" name="toAddress" type="email" placeholder="name@shipblu.com" />
          </div>
          <div>
            <Label htmlFor="ccAddresses">CC (optional)</Label>
            <Input id="ccAddresses" name="ccAddresses" placeholder="comma, separated" />
          </div>
        </div>
      ) : (
        <input type="hidden" name="ccAddresses" value="" />
      )}

      <Textarea
        name="body"
        rows={4}
        required
        // The tracking number is already on screen; retyping it is the one place
        // in this business where a transposed digit sends a hub looking for
        // somebody else's parcel.
        defaultValue={trackingPrefill(trackingNumbers)}
        placeholder="Ask the hub what is actually happening with this parcel…"
        className="border-violet-500/40 bg-violet-500/5"
      />

      {anchor ? (
        <label className="flex items-start gap-2 rounded-md border border-[var(--border)] p-2 text-xs">
          <input type="checkbox" name="includeAnchor" defaultChecked className="mt-0.5" />
          <span>
            <span className="font-medium">Quote the customer&apos;s last message</span>
            {/* No `block` beside the clamp: `display: block` and the clamp's
                own `display: -webkit-box` are the same property, and the one
                that won left a long WhatsApp message unclamped — five lines of
                quote that pushed the send button off a phone screen. */}
            <span className="line-clamp-1 opacity-60">{anchor.bodyText}</span>
          </span>
        </label>
      ) : null}

      <ErrorText>{state.error}</ErrorText>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs opacity-70">
          <input type="checkbox" name="setPending" defaultChecked />
          Set this ticket to Pending
        </label>
        <NotVisible />
        <Button type="submit" disabled={busy} className="ms-auto">
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The sidebar index.
 *
 * What makes a thread findable on a ticket with sixty messages, and the only
 * place the *set* of them is visible at once — which is how an agent notices the
 * one from Tuesday that nobody ever closed.
 */
export function SideConversationsField({ sides }: { sides: SideConversationView[] }) {
  if (sides.length === 0) {
    return <p className="text-xs opacity-50">None yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {sides.map((side) => (
        <li key={side.id} className="text-xs">
          <a href={`#side-${side.number}`} className="flex items-start gap-1.5 hover:underline">
            <span
              aria-hidden="true"
              className={`mt-1 size-1.5 shrink-0 rounded-full ${
                side.state === 'done'
                  ? 'bg-[var(--muted-foreground)]'
                  : side.awaitingReply
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
              }`}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{describeRecipient(side)}</span>
              <span className="block opacity-60">
                {side.state === 'done'
                  ? 'done'
                  : side.awaitingReply
                    ? `awaiting reply · ${formatRelative(side.lastMessageAt)}`
                    : `replied · ${formatRelative(side.lastMessageAt)}`}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
