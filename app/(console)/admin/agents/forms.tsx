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
  const [copied, setCopied] = useState(false);

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      {/* Stacked on a phone: three fields sharing one row leaves an email box
          about eleven characters wide. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="sm:flex-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="sm:flex-1">
          <Label htmlFor="name">Name (optional)</Label>
          <Input id="name" name="name" />
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
          <p className="mb-1.5 text-xs font-medium opacity-70">
            Send this link to the new agent. It is shown once and expires in 7 days.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-xs">{state.inviteUrl}</code>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(state.inviteUrl!);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}

      <SubmitButton className="self-start" idle="Create invite" busy="Creating…" />
    </form>
  );
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
            The most open tickets auto-assignment will give this agent at once. Leave it blank and
            the group&rsquo;s default cap applies; with neither set they are uncapped. It never
            stops you assigning a ticket by hand.
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
