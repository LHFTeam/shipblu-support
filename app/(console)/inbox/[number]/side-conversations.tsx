'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { HubIcon } from '@/components/icons';
import { Badge, Button, ErrorText, Input, Label, Notice, Select, Textarea } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { PickerEntry, SideConversationView } from '@/lib/side-conversations/queries';
import {
  blankSideSubject,
  describeRecipient,
  isQuotableAnchor,
  subjectPrefill,
  trackingPrefill,
} from '@/lib/side-conversations/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm, type FormHandlers } from '@/components/use-action-form';
import { INITIAL, LOST_SEND } from './form-state';
import {
  replyToSideConversation,
  setSideConversationState,
  startSideConversation,
} from '../../side-conversation-actions';
import { AttachmentList } from './attachments';

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
 * ## Told apart by form, and said out loud
 *
 * Amber is already the private note. A side conversation is a *third* kind of
 * writing on a ticket the customer cannot see, and the failure mode of confusing
 * it with the reply box is the worst one this feature has: an internal question
 * about a customer, sent to that customer. It used to be violet for that reason;
 * violet now means one thing across the product, a parcel out for delivery, so
 * the card is told apart by its shape instead — a full-width bordered card with
 * the hub mark, beside the blue reply bubble and the amber note with its lock —
 * and its state by the hub tones, coral when the other side has answered and
 * somebody here has to read it. Every card and every input still says "Not
 * visible to the customer" in words. That label is load-bearing, not decoration.
 */

/** Said on every surface an agent can type into. */
function NotVisible() {
  return (
    <span className="text-2xs text-(--color-text-secondary)">Not visible to the customer</span>
  );
}

/** The thread's state in words, the same on the card and in the sidebar's index. */
function SideState({ side, since }: { side: SideConversationView; since?: boolean }) {
  if (side.state === 'done') return <Badge tone="resolved">Done</Badge>;
  if (side.awaitingReply) {
    return <Badge tone="hub-waiting">Awaiting reply · {formatRelative(side.lastMessageAt)}</Badge>;
  }
  return (
    <Badge tone="hub-replied">
      Replied{since ? ` · ${formatRelative(side.lastMessageAt)}` : ''}
    </Badge>
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
      className="mt-3.5 scroll-mt-4 self-stretch overflow-hidden rounded-xl border border-(--color-border-default) bg-(--color-background-surface) first:mt-0 [[data-chat-event]+&]:mt-0"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border-subtle) bg-(--color-background-surface-sunken) px-3.5 py-2.5 text-xs">
        <HubIcon size={15} className="shrink-0" />
        <span className="font-semibold">Side conversation · {describeRecipient(side)}</span>
        <SideState side={side} />
        <span className="ms-auto flex flex-wrap items-center gap-x-1.5 text-(--color-text-secondary)">
          <NotVisible />
          <span aria-hidden>·</span>
          <span>{formatDateTime(side.createdAt)}</span>
        </span>
      </div>

      <p dir="auto" className="px-3.5 pt-2.5 text-start text-sm font-medium">
        {side.subject}
      </p>

      {!open ? (
        <div className="px-3.5 pt-1 pb-3">
          {last ? (
            <p dir="auto" className="line-clamp-2 text-start text-sm text-(--color-text-secondary)">
              <span className="font-medium text-(--color-text-primary)">
                {last.direction === 'inbound' ? (last.authorName ?? 'They') : 'We'} said:
              </span>{' '}
              {last.bodyText}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-1.5 text-xs font-medium text-(--color-text-link) hover:underline"
          >
            Open thread ({count} {count === 1 ? 'message' : 'messages'})
          </button>
        </div>
      ) : (
        <div className="pb-3">
          <ol className="px-3.5 py-1">
            {side.messages.map((message) => (
              <li
                key={message.id}
                className="border-t border-(--color-border-subtle) py-2 first:border-t-0"
              >
                {/*
                  An out-of-office is not the hub's answer. Dimmed rather than
                  hidden: "we heard back but only from a robot" is information.
                  The words only, not the message: opacity cannot be undone by a
                  child, and a photo opened from the files below is opened to be
                  read.
                */}
                <div className={message.isAutomated ? 'opacity-60' : undefined}>
                  <div className="flex items-baseline gap-2 text-xs text-(--color-text-secondary)">
                    <span className="font-semibold text-(--color-text-primary)">
                      {message.authorName ?? (message.direction === 'inbound' ? 'They' : 'We')}
                    </span>
                    {message.isAutomated ? <Badge tone="automated">Auto-reply</Badge> : null}
                    <span className="ms-auto shrink-0">{formatDateTime(message.createdAt)}</span>
                  </div>

                  {message.bodyHtml ? (
                    <div
                      dir="auto"
                      className="mt-1 text-start text-sm/5 [&_a]:text-(--color-text-link) [&_a]:underline"
                      dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
                    />
                  ) : (
                    <p dir="auto" className="mt-1 text-start text-sm/5 whitespace-pre-wrap">
                      {message.bodyText}
                    </p>
                  )}
                </div>

                <AttachmentList files={message.attachments} compact />

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

          {canWrite ? <SideReplyForm side={side} /> : null}

          <div className="mt-2 flex items-center gap-2 px-3.5">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Collapse
            </Button>
            {canWrite ? <StateButton side={side} /> : null}
          </div>
        </div>
      )}
    </li>
  );
}

function SideReplyForm({ side }: { side: SideConversationView }) {
  const { state, key, form } = useActionForm(replyToSideConversation, INITIAL, {
    lost: LOST_SEND,
  });

  return (
    <form key={key} {...form} className="mt-1 flex flex-col gap-1.5 px-3.5">
      <input type="hidden" name="sideConversationId" value={side.id} />
      <Textarea
        name="body"
        rows={2}
        required
        placeholder={`Write back to ${describeRecipient(side)}…`}
      />
      <ErrorText>{state.error}</ErrorText>
      <div className="flex items-center gap-2">
        <NotVisible />
        <SubmitButton idle="Send" busy="Sending…" className="ms-auto" />
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
    const result = await setSideConversationState(INITIAL, formData);
    setBusy(false);
    // A success brings the re-read page with it. A refusal revalidates nothing
    // and is not shown, and it mostly means the thread changed under the agent,
    // so the page is re-read to say how.
    if (result.error) router.refresh();
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={busy}
      loading={busy}
      onClick={() => void toggle()}
      className="ms-auto"
    >
      {side.state === 'open' ? 'Mark done' : 'Reopen'}
    </Button>
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
  // Through `useActionForm`, which matters more here than anywhere: React's
  // reset after a refusal put the first hub back in the picker while the
  // component still held the agent's choice, and the next Send went to that
  // hub (`docs/PROJECT-STATE.md` §6.80).
  const { state, key, form } = useActionForm(startSideConversation, INITIAL, {
    lost: LOST_SEND,
    onSuccess: onSent,
  });

  return (
    <SideConversationDraft
      key={key}
      conversation={conversation}
      recipients={recipients}
      error={state.error}
      form={form}
    />
  );
}

/**
 * The form itself, a component of its own so that the `key` above resets the
 * picker along with the fields — `docs/PROJECT-STATE.md` §6.58. The recipient
 * used to be deliberately sticky and lived above the key; now that nobody is
 * preselected, a recipient carried over from the last thread is exactly the
 * preselection that default exists to prevent.
 */
function SideConversationDraft({
  conversation,
  recipients,
  error,
  form,
}: {
  conversation: ConversationDetail;
  recipients: PickerEntry[];
  error: string | null;
  form: FormHandlers;
}) {
  // Nobody is preselected. Opening on the first entry meant an agent who sent
  // without touching the picker asked whichever hub sorts first by name —
  // Alexandria, once the hubs were entered — about a parcel it may never have
  // seen, carrying the customer's name and address. "Choose…" makes the
  // recipient something the agent decided, and `required` stops the form until
  // they have. With an empty directory there is nothing to choose between, so
  // it opens on the typed address the notice below tells them to use.
  const [recipientId, setRecipientId] = useState(recipients.length > 0 ? '' : 'other');

  // The last thing the customer actually said. Both the anchor the thread hangs
  // off and, optionally, the text quoted into the question.
  const anchor = [...conversation.messages].reverse().find(isQuotableAnchor);

  const trackingNumbers = conversation.shipments.map((shipment) => shipment.trackingNumber);

  // Hubs first: they are what a late parcel is almost always about.
  const GROUPS: { kind: PickerEntry['kind']; label: string }[] = [
    { kind: 'hub', label: 'Hubs and warehouses' },
    { kind: 'team', label: 'Internal teams' },
    { kind: 'vendor', label: 'Vendors' },
  ];

  return (
    <form {...form} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversation.id} />
      <input type="hidden" name="anchorMessageId" value={anchor?.id ?? ''} />

      {recipients.length === 0 ? (
        <Notice tone="warning" icon>
          No hubs or teams have been entered yet, so there is nobody to pick. Add ShipBlu&apos;s
          locations under <span className="font-medium">Settings → Locations</span>, and anyone who
          is not a location under <span className="font-medium">Internal recipients</span>. Until
          then you can still type an address by hand.
        </Notice>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <Label htmlFor="recipientId">Ask</Label>
          <Select
            id="recipientId"
            name="recipientId"
            value={recipientId}
            onChange={(event) => setRecipientId(event.target.value)}
            required
          >
            {/* Not `disabled`. Anything that resets this form lands on the
                first option that is not, and "Choose…" is the only safe place
                for it to land. Choosing it again on purpose is harmless:
                `required` refuses the empty value. Dropped only when the
                directory is empty and the value is "Someone else…": a refresh
                can empty the directory under an open form, and a value with no
                option left to show it — unchosen, or an entry that has just
                gone — would otherwise display "Someone else…" without the
                address field, and picking it again changes nothing. */}
            {recipients.length > 0 || recipientId !== 'other' ? (
              <option value="">Choose…</option>
            ) : null}
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
          {/* Empty unless the ticket has exactly one parcel — see
              `subjectPrefill`. The placeholder is what leaving it blank sends,
              from the same `blankSideSubject` the action sends it with, so the
              two cannot disagree. */}
          <Input
            id="subject"
            name="subject"
            defaultValue={subjectPrefill(trackingNumbers)}
            placeholder={blankSideSubject(conversation.subject)}
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
      />

      {anchor ? (
        <label className="flex items-start gap-2 rounded-md border border-(--color-border-subtle) p-2 text-xs">
          <input
            type="checkbox"
            name="includeAnchor"
            defaultChecked
            className="mt-0.5 size-4 shrink-0 accent-(--color-control-accent)"
          />
          <span>
            <span className="font-medium">Quote the customer&apos;s last message</span>
            {/* No `block` beside the clamp: `display: block` and the clamp's
                own `display: -webkit-box` are the same property, and the one
                that won left a long WhatsApp message unclamped — five lines of
                quote that pushed the send button off a phone screen. */}
            <span className="line-clamp-1 text-(--color-text-secondary)">{anchor.bodyText}</span>
          </span>
        </label>
      ) : null}

      <ErrorText>{error}</ErrorText>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-(--color-text-secondary)">
          <input
            type="checkbox"
            name="setPending"
            defaultChecked
            className="size-4 shrink-0 accent-(--color-control-accent)"
          />
          Set this ticket to Pending
        </label>
        <NotVisible />
        <SubmitButton idle="Send" busy="Sending…" className="ms-auto" />
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
    return <p className="text-sm text-(--color-text-tertiary)">None yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {sides.map((side) => (
        <li key={side.id}>
          <a
            href={`#side-${side.number}`}
            className="flex min-w-0 flex-col items-start gap-0.5 rounded-md text-sm hover:underline"
          >
            <span className="max-w-full truncate font-medium">{describeRecipient(side)}</span>
            <SideState side={side} since />
          </a>
        </li>
      ))}
    </ul>
  );
}
