'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorText, Input, Label, Select } from '@/components/ui';
import { InfoTip, Tooltip } from '@/components/tooltip';
import { formatRelative } from '@/lib/format';
import { createInvite, setAgentActive, setAgentCapacity, type AdminState } from '../actions';

const INITIAL: AdminState = { error: null };

export function InviteForm() {
  const [state, action] = useActionState(createInvite, INITIAL);

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      {/* Stacked on a phone: three fields sharing one row leaves an email box
          about eleven characters wide. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        {/* `autoComplete="off"` on both: an email-plus-name pair is an address
            form as far as Chrome and Safari are concerned, so they offer the
            signed-in admin's own details — into a form that is entirely about
            somebody else. Getting that wrong here does not just misaddress the
            invite, it puts the wrong person's name in the greeting and on the
            new agent record. */}
        <div className="sm:flex-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required autoComplete="off" />
        </div>
        <div className="sm:flex-1">
          <Label htmlFor="name">Name</Label>
          {/* Required, because this is the name the invitee is greeted by in
              the invitation email and reads back on the activation page. The
              admin knows who they are inviting; the invitee should not have to
              tell us who they are. */}
          <Input id="name" name="name" required autoComplete="off" maxLength={120} />
        </div>
        <div className="sm:w-40">
          <Label htmlFor="role">Role</Label>
          <Select id="role" name="role" defaultValue="agent">
            <option value="agent">Agent</option>
            <option value="supervisor">Supervisor</option>
            <option value="admin">Admin</option>
          </Select>
        </div>
      </div>

      <ErrorText>{state.error}</ErrorText>

      {state.inviteUrl ? (
        <div className="rounded-md bg-[var(--muted)] p-3 text-sm">
          {/* Which of the two happened is the part an admin has to read. The
              link is shown either way, so without this sentence a successful
              send and a send that never left look identical — and the second
              one needs them to go and paste the link somewhere.

              "On its way", not "emailed": all this action did was queue a job.
              The worker still has to run and the provider still has to accept
              the recipient, so claiming it was delivered would recreate the
              silent failure the message exists to rule out.

              Coloured with a token rather than dimmed with `opacity-70`,
              because opacity composites the whole element — a child cannot
              exceed its parent's, so the `opacity-100` that used to be on the
              address was a no-op and the one word worth reading back for a
              typo was as faint as the rest of the sentence. */}
          <p className="mb-1.5 text-xs font-medium text-[var(--muted-foreground)]">
            {state.inviteQueuedFor ? (
              <>
                The invitation is on its way to{' '}
                <span className="break-all text-[var(--foreground)]">{state.inviteQueuedFor}</span>.
                The same link is below if you need to send it another way.
              </>
            ) : (
              <>
                No invitation email went out, so send this link to the new agent yourself. (The
                server log says why — usually no sending address is configured yet.)
              </>
            )}{' '}
            It expires in 7 days and remains under Pending invites until it is accepted.
          </p>
          <CopyInviteLink
            key={state.inviteUrl}
            inviteUrl={state.inviteUrl}
            label="Copy invite link"
          />
        </div>
      ) : null}

      <SubmitButton className="self-start" idle="Create invite" busy="Creating…" />
    </form>
  );
}

function CopyInviteLink({ inviteUrl, label }: { inviteUrl: string; label: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      className="flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-start transition-colors hover:bg-[var(--muted)] focus:ring-2 focus:ring-brand-500/30 focus:outline-none"
    >
      <code className="min-w-0 flex-1 truncate text-xs">{inviteUrl}</code>
      <span
        aria-live="polite"
        className={`shrink-0 text-xs font-medium ${copyState === 'failed' ? 'text-red-600 dark:text-red-300' : 'text-brand-700 dark:text-brand-300'}`}
      >
        {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Could not copy' : 'Copy'}
      </span>
    </button>
  );
}

export function PendingInviteLink({
  inviteUrl,
  email,
  unavailableMessage,
}: {
  inviteUrl: string | null;
  email: string;
  unavailableMessage: string | null;
}) {
  if (!inviteUrl) {
    return <p className="text-xs opacity-50">{unavailableMessage ?? 'Link unavailable.'}</p>;
  }

  return <CopyInviteLink inviteUrl={inviteUrl} label={`Copy invite link for ${email}`} />;
}

/**
 * `formatRelative` answers "now" inside the first minute and an absolute date
 * past a month, and neither of those takes the "seen … ago" the durations do:
 * the row read "seen now ago", and would have read "seen 3 Jul 2026, 14:02 ago"
 * for anyone who had been away long enough to be worth noticing.
 */
function lastSeen(value: Date | string | null): string {
  if (!value) return 'never signed in';
  const relative = formatRelative(value);
  if (relative === 'now') return 'seen just now';
  return /^\d+[mhd]$/.test(relative) ? `seen ${relative} ago` : `seen ${relative}`;
}

export function AgentRow({
  agent,
  isSelf,
}: {
  agent: {
    id: string;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
    lastSeenAt: Date | string | null;
    presence: 'online' | 'away' | 'offline';
    isAcceptingTickets: boolean;
    maxOpenTickets: number | null;
  };
  isSelf: boolean;
}) {
  const [state, action] = useActionState(setAgentActive, INITIAL);
  const [capacityState, capacityAction] = useActionState(setAgentCapacity, INITIAL);

  // What assignment actually sees, which is not what either column says on its
  // own: connected but switched off is "away", and it is the state an admin
  // wondering why somebody is getting no tickets needs to be shown.
  const availability =
    agent.presence === 'online' ? (agent.isAcceptingTickets ? 'online' : 'away') : 'offline';

  /*
   * One row per agent above `sm`, three stacked bands below it.
   *
   * Everything here — a name, three badges, a capacity box, a last-seen stamp
   * and a button — is about 560px of content, so a single non-wrapping row on a
   * phone pushed the buttons off the side of the screen and squeezed the name
   * that identifies the row down to an ellipsis. The bands keep the reading
   * order (who, what state, what you can do about it) at every width.
   */
  return (
    <li className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:gap-3 sm:py-2.5">
      <div className="min-w-0 sm:flex-1">
        <p className="truncate font-medium">
          {agent.name} {isSelf ? <span className="opacity-50">(you)</span> : null}
        </p>
        <p className="truncate text-xs opacity-50">{agent.email}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{agent.role.replace('_', ' ')}</Badge>
        {!agent.isActive ? <Badge tone="danger">deactivated</Badge> : null}
        <Tooltip
          label="Availability"
          content={
            <>
              What assignment sees, which is not the same as being signed in. <b>Online</b> is
              connected and accepting tickets; <b>away</b> is connected with &ldquo;accepting
              tickets&rdquo; switched off, so nothing is routed to them; <b>offline</b> is no open
              console.
            </>
          }
        >
          <Badge
            tone={
              availability === 'online'
                ? 'success'
                : availability === 'away'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {availability}
          </Badge>
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <form action={capacityAction} className="flex shrink-0 items-center gap-1">
          <input type="hidden" name="agentId" value={agent.id} />
          <label className="text-xs opacity-50" htmlFor={`cap-${agent.id}`}>
            cap
          </label>
          <InfoTip label="Ticket cap">
            The most tickets on an open status auto-assignment will give this agent at once. A
            ticket waiting on the customer on a pending status does not count towards it. Leave it
            blank and the group&rsquo;s default cap applies; with neither set they are uncapped. It
            never stops you assigning a ticket by hand.
          </InfoTip>
          {/* 16px on a phone for the same reason as every other field in the
              console: iOS zooms into anything smaller and does not zoom back. */}
          <input
            id={`cap-${agent.id}`}
            name="maxOpenTickets"
            type="number"
            min={0}
            defaultValue={agent.maxOpenTickets ?? ''}
            placeholder="group"
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            className="w-16 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-base sm:text-xs"
          />
        </form>

        <span className="shrink-0 text-xs opacity-50">{lastSeen(agent.lastSeenAt)}</span>

        <form action={action} className="ms-auto sm:ms-0">
          <input type="hidden" name="agentId" value={agent.id} />
          <input type="hidden" name="active" value={agent.isActive ? 'false' : 'true'} />
          <Button
            type="submit"
            variant={agent.isActive ? 'secondary' : 'primary'}
            disabled={isSelf}
          >
            {agent.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </form>
      </div>

      {state.error || capacityState.error ? (
        <span className="text-xs text-red-600">{state.error ?? capacityState.error}</span>
      ) : null}
    </li>
  );
}

function SubmitButton({
  idle,
  busy,
  className,
}: {
  idle: string;
  busy: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className={className}>
      {pending ? busy : idle}
    </Button>
  );
}
