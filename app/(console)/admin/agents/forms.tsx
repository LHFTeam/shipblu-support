'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorText, Input, Label, Select } from '@/components/ui';
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
      <div className="flex gap-3">
        <div className="flex-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="flex-1">
          <Label htmlFor="name">Name (optional)</Label>
          <Input id="name" name="name" />
        </div>
        <div className="w-40">
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

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {agent.name} {isSelf ? <span className="opacity-50">(you)</span> : null}
        </p>
        <p className="truncate text-xs opacity-50">{agent.email}</p>
      </div>

      <Badge>{agent.role.replace('_', ' ')}</Badge>
      {!agent.isActive ? <Badge tone="danger">deactivated</Badge> : null}
      <Badge
        tone={
          availability === 'online' ? 'success' : availability === 'away' ? 'warning' : 'neutral'
        }
      >
        {availability}
      </Badge>

      <form action={capacityAction} className="ml-auto flex shrink-0 items-center gap-1">
        <input type="hidden" name="agentId" value={agent.id} />
        <label className="text-xs opacity-50" htmlFor={`cap-${agent.id}`}>
          cap
        </label>
        <input
          id={`cap-${agent.id}`}
          name="maxOpenTickets"
          type="number"
          min={0}
          defaultValue={agent.maxOpenTickets ?? ''}
          placeholder="group"
          onBlur={(event) => event.currentTarget.form?.requestSubmit()}
          className="w-16 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-xs"
        />
      </form>

      <span className="shrink-0 text-xs opacity-50">
        {agent.lastSeenAt ? `seen ${formatRelative(agent.lastSeenAt)} ago` : 'never signed in'}
      </span>

      <form action={action}>
        <input type="hidden" name="agentId" value={agent.id} />
        <input type="hidden" name="active" value={agent.isActive ? 'false' : 'true'} />
        <Button type="submit" variant={agent.isActive ? 'secondary' : 'primary'} disabled={isSelf}>
          {agent.isActive ? 'Deactivate' : 'Reactivate'}
        </Button>
      </form>

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
