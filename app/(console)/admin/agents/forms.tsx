'use client';

import { useActionState, useRef, useState } from 'react';
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Label,
  Select,
  SuccessText,
} from '@/components/ui';
import { RelativeTime } from '@/components/relative-time';
import { InfoTip, Tooltip } from '@/components/tooltip';
import { ago, sentenceCase } from '@/lib/format';
import { EditorForm } from '../forms-shared';
import type { AdminState } from '../settings-shared';
import {
  createInvite,
  saveAgent,
  savePresenceSettings,
  setAgentActive,
  setAgentCapacity,
} from './actions';
import type { ActionState } from '@/lib/http/action-state';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: AdminState = { error: null };
const SETTINGS_INITIAL: ActionState = { error: null };

/**
 * The two idle windows, and the only place they are set.
 *
 * On the Agents page rather than a settings page of its own because it is a
 * rule about these people, read next to the list it governs — an admin
 * wondering why somebody shows as away should find the answer on the screen
 * where they noticed it.
 *
 * Both boxes are emptied to turn a timer off, which is why the hint says so
 * rather than leaving an admin to guess whether 0 means "immediately" or
 * "never".
 */
export function IdlePolicyForm({
  autoAwayAfterMins,
  autoSignoutAfterMins,
}: {
  autoAwayAfterMins: number | null;
  autoSignoutAfterMins: number | null;
}) {
  const { state, form } = useActionForm(savePresenceSettings, SETTINGS_INITIAL);

  return (
    <form
      {...form}
      className="flex flex-col gap-3 rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)"
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field
          className="sm:w-56"
          label="Stop routing work after"
          hint="Minutes without a key or a click. Empty to turn it off."
          explain={
            <>
              An agent who stops using the console is marked <b>away</b> and gets no new tickets,
              exactly as if they had switched themselves off. The difference is that this one undoes
              itself: the moment they touch the keyboard they are back in the rota. It measures
              input, not the connection &mdash; a console left open on an empty desk stays connected
              all day.
            </>
          }
        >
          <Input
            name="autoAwayAfterMins"
            type="number"
            min={1}
            max={1440}
            step={1}
            defaultValue={autoAwayAfterMins ?? ''}
            placeholder="off"
          />
        </Field>

        <Field
          className="sm:w-56"
          label="Sign out after"
          hint="Minutes without a key or a click. Empty to turn it off."
          explain={
            <>
              The session is destroyed and the agent signs in again. They get a countdown first,
              because an unsent reply lives only in the browser. This cannot be shorter than the
              away window &mdash; signing somebody out before ever marking them away would mean
              nobody is ever seen as away. It applies per browser, so the machine being typed on
              stays signed in while one left at home does not.
            </>
          }
        >
          <Input
            name="autoSignoutAfterMins"
            type="number"
            min={1}
            max={1440}
            step={1}
            defaultValue={autoSignoutAfterMins ?? ''}
            placeholder="off"
          />
        </Field>
      </div>

      <ErrorText>{state.error}</ErrorText>
      {state.ok ? <SuccessText>Saved.</SuccessText> : null}

      <SubmitButton className="self-start" idle="Save" busy="Saving…" />
    </form>
  );
}

type Choice = { value: string; label: string };

export function InviteForm({ groups }: { groups: Choice[] }) {
  const { state, key, form } = useActionForm(createInvite, INITIAL);

  // Keyed on the last success, so a sent invitation clears the address and the
  // name; the link and what happened to it render from `state`, above the key.
  return (
    <form
      key={key}
      {...form}
      className="flex flex-col gap-3 rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)"
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

      {/* Chosen here because an agent in no group opens the console to an
          empty inbox: they see their groups' tickets and what is assigned to
          them, and nothing else. */}
      {groups.length > 0 ? (
        <Field
          as="group"
          label="Groups"
          hint="They join these when they accept. You can change them later from Edit on their row."
        >
          <GroupCheckboxes name="groupIds" groups={groups} />
        </Field>
      ) : null}

      <ErrorText>{state.error}</ErrorText>

      {state.inviteUrl ? (
        <div className="rounded-md bg-(--color-background-surface-sunken) p-3 text-sm">
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
          <p className="mb-1.5 text-xs font-medium text-(--color-text-secondary)">
            {state.inviteQueuedFor ? (
              <>
                The invitation is on its way to{' '}
                <span className="break-all text-(--color-text-primary)">
                  {state.inviteQueuedFor}
                </span>
                . The same link is below if you need to send it another way.
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
      className="flex w-full min-w-0 items-center gap-2 rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) px-2.5 py-2 text-start transition-colors hover:bg-(--color-background-hover)"
    >
      <code className="min-w-0 flex-1 truncate text-xs">{inviteUrl}</code>
      <span
        aria-live="polite"
        className={`shrink-0 text-xs font-medium ${copyState === 'failed' ? 'text-(--color-feedback-danger-fg)' : 'text-(--color-text-link)'}`}
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
    return (
      <p className="text-xs text-(--color-text-tertiary)">
        {unavailableMessage ?? 'Link unavailable.'}
      </p>
    );
  }

  return <CopyInviteLink inviteUrl={inviteUrl} label={`Copy invite link for ${email}`} />;
}

/**
 * A set of group checkboxes under one name. A box drawn ticked also posts a
 * hidden `${name}Held`, so the save writes only the boxes somebody clicked
 * (`MembershipChoice`) — the invite draws none ticked, so posts none.
 */
function GroupCheckboxes({
  name,
  groups,
  checked = [],
}: {
  name: string;
  groups: Choice[];
  checked?: string[];
}) {
  const held = new Set(checked);
  return (
    <div className="mt-1 grid gap-1 sm:grid-cols-2">
      {groups.map((group) => (
        <label key={group.value} className="flex min-w-0 items-center gap-2 text-sm">
          {held.has(group.value) ? (
            <input type="hidden" name={`${name}Held`} value={group.value} />
          ) : null}
          <input
            type="checkbox"
            name={name}
            value={group.value}
            defaultChecked={held.has(group.value)}
            className="size-4 shrink-0 accent-(--color-control-accent)"
          />
          <span className="min-w-0 truncate">{group.label}</span>
        </label>
      ))}
    </div>
  );
}

type AgentSummary = {
  id: string;
  name: string;
  email: string;
  role: 'agent' | 'supervisor' | 'admin' | 'account_admin';
  isActive: boolean;
  lastSeenAt: Date | string | null;
  presence: 'online' | 'away' | 'offline';
  isAcceptingTickets: boolean;
  maxOpenTickets: number | null;
  groupIds: string[];
  /** Owns a WhatsApp number, whose tickets reach them whatever their groups. */
  ownsNumber: boolean;
};

/**
 * The list, and which row's editor is open.
 *
 * Held here so opening a second agent closes the first: two editors open at
 * once is how you save the wrong person's address.
 */
export function AgentList({
  agents,
  groups,
  selfId,
}: {
  agents: AgentSummary[];
  groups: Choice[];
  selfId: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <ul className="divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface)">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          groups={groups}
          isSelf={agent.id === selfId}
          editing={editingId === agent.id}
          onEdit={() => setEditingId(editingId === agent.id ? null : agent.id)}
          onClose={() => setEditingId(null)}
        />
      ))}
    </ul>
  );
}

const ROLE_CHOICES: { value: AgentSummary['role']; label: string }[] = [
  { value: 'agent', label: 'Agent' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'admin', label: 'Admin' },
  { value: 'account_admin', label: 'Account admin' },
];

/**
 * One agent's name, address, role and groups, saved together by `saveAgent`.
 *
 * The role select is disabled on your own row rather than left for the action
 * to refuse: a disabled control posts nothing, which the action reads as "no
 * change", so the form cannot even ask. What else may be refused — the last
 * account admin, an address somebody already signs in with — only the server
 * can know, and it answers in a sentence under the form.
 */
function AgentEditor({
  agent,
  groups,
  isSelf,
  onClose,
}: {
  agent: AgentSummary;
  groups: Choice[];
  isSelf: boolean;
  onClose: () => void;
}) {
  return (
    <div
      id={`agent-editor-${agent.id}`}
      className="mt-3 rounded-md border border-(--color-border-focus)/30 p-3"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-sm font-semibold">Edit {agent.name}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>

      <EditorForm action={saveAgent} submitLabel="Save" onSaved={onClose}>
        <input type="hidden" name="agentId" value={agent.id} />
        <div className="grid gap-3 sm:grid-cols-2">
          {/* `autoComplete="off"` for the invite form's reason: a name and an
              address side by side is an address form to the browser, which
              offers the signed-in admin's own details. */}
          <Field label="Name">
            <Input
              name="name"
              defaultValue={agent.name}
              required
              maxLength={120}
              autoComplete="off"
            />
          </Field>
          <Field label="Email" hint="What they sign in with, so tell them when it changes.">
            <Input
              name="email"
              type="email"
              defaultValue={agent.email}
              required
              autoComplete="off"
            />
          </Field>

          <Field
            label="Role"
            hint={isSelf ? 'Nobody can change their own role.' : 'Takes effect on their next page.'}
            explain={
              <>
                <b>Agent</b> sees their groups&rsquo; tickets and anything assigned to them.{' '}
                <b>Supervisor</b> sees every ticket, and adds reports and the knowledge base.{' '}
                <b>Admin</b> adds every setting, these included. <b>Account admin</b> is an admin
                who also holds billing; the last active one keeps the role.
              </>
            }
          >
            {/* Named outright: `Field` puts its InfoTip button inside the label,
              and a label with no `for` names its first labelable descendant —
              the button — so the select would reach a screen reader unnamed. */}
            <Select name="role" defaultValue={agent.role} disabled={isSelf} aria-label="Role">
              {ROLE_CHOICES.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          as="group"
          label="Groups"
          hint="An agent sees the tickets of every group they are in, and auto-assignment hands a group's tickets only to its members."
        >
          {groups.length > 0 ? (
            <GroupCheckboxes name="groupIds" groups={groups} checked={agent.groupIds} />
          ) : (
            <p className="mt-1 text-xs text-(--color-text-secondary)">
              No groups yet. Add one under Groups.
            </p>
          )}
        </Field>
      </EditorForm>
    </div>
  );
}

/** Badge words are sentence case; the role and the availability are stored lower case. */

function AgentRow({
  agent,
  groups,
  isSelf,
  editing,
  onEdit,
  onClose,
}: {
  agent: AgentSummary;
  groups: Choice[];
  isSelf: boolean;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
}) {
  const [state, action] = useActionState(setAgentActive, INITIAL);
  const capacity = useActionForm(setAgentCapacity, INITIAL);
  // What the capacity box last sent, starting from the saved cap. A blur that
  // changes nothing sends nothing: a refused value stays in the box now that no
  // reset puts the saved one back, and sending it again on every focus change
  // only repeats the same refusal. It also stops tabbing down the list from
  // writing every row. Enter in the box still submits it, so an agent can send
  // the same value again on purpose — after a dropped connection, say.
  const capacitySent = useRef(String(agent.maxOpenTickets ?? ''));

  // What assignment actually sees, which is not what either column says on its
  // own: connected but switched off is "away", and it is the state an admin
  // wondering why somebody is getting no tickets needs to be shown.
  const availability =
    agent.presence === 'online' ? (agent.isAcceptingTickets ? 'online' : 'away') : 'offline';

  const groupNames = groups
    .filter((group) => agent.groupIds.includes(group.value))
    .map((group) => group.label);

  /*
   * One row per agent above `sm`, three stacked bands below it.
   *
   * Everything here — a name, up to four badges, a capacity box, a last-seen
   * stamp and two buttons — is about 660px of content, so a single non-wrapping
   * row on a phone pushed the buttons off the side of the screen and squeezed
   * the name that identifies the row down to an ellipsis. The bands keep the
   * reading order (who, what state, what you can do about it) at every width.
   * Above `sm` the row wraps rather than shrinking the name, which keeps
   * 12rem: on a tablet the name column otherwise went to nothing beside the
   * badges and buttons, and the row stopped saying who it was about.
   */
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="min-w-0 sm:min-w-48 sm:flex-1">
          <p className="truncate font-medium">
            {agent.name}{' '}
            {isSelf ? <span className="text-(--color-text-tertiary)">(you)</span> : null}
          </p>
          <p className="truncate text-xs text-(--color-text-tertiary)">{agent.email}</p>
          <p className="truncate text-xs text-(--color-text-secondary)">
            {groupNames.length > 0 ? groupNames.join(' · ') : 'In no group'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{sentenceCase(agent.role)}</Badge>
          {!agent.isActive ? <Badge tone="neutral">Deactivated</Badge> : null}
          {/* Only for the agent role, where it is a fault: a supervisor or an
            admin in no group still sees every ticket, but an agent sees only
            what is assigned to them, and auto-assignment never picks them.
            Not for the owner of a WhatsApp number either, who sees and is
            handed every ticket on it whatever their groups — an owner who
            answers only their own phone is meant to be in none. */}
          {agent.isActive &&
          agent.role === 'agent' &&
          !agent.ownsNumber &&
          groupNames.length === 0 ? (
            <Tooltip
              label="No group"
              content={
                <>
                  An agent sees only the tickets of their groups and the ones assigned to them, and
                  auto-assignment hands a group&rsquo;s tickets only to its members. In no group,
                  their inbox stays empty until somebody assigns them a ticket by hand.
                </>
              }
            >
              <Badge tone="warning">No group</Badge>
            </Tooltip>
          ) : null}
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
              {sentenceCase(availability)}
            </Badge>
          </Tooltip>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <form {...capacity.form} className="flex shrink-0 items-center gap-1">
            <input type="hidden" name="agentId" value={agent.id} />
            <label className="text-xs text-(--color-text-tertiary)" htmlFor={`cap-${agent.id}`}>
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
              onBlur={(event) => {
                const value = event.currentTarget.value;
                if (value === capacitySent.current) return;
                capacitySent.current = value;
                event.currentTarget.form?.requestSubmit();
              }}
              // Enter submits the form itself; noted, so the blur after it does
              // not send the same value a second time.
              onKeyDown={(event) => {
                if (event.key === 'Enter') capacitySent.current = event.currentTarget.value;
              }}
              className="w-16 rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) px-1.5 py-1 text-base outline-none hover:border-(--color-border-default) focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20 sm:text-xs"
            />
          </form>

          <span className="shrink-0 text-xs text-(--color-text-tertiary)">
            {agent.lastSeenAt ? (
              <RelativeTime at={agent.lastSeenAt}>
                {(relative) => `seen ${ago(relative)}`}
              </RelativeTime>
            ) : (
              'never signed in'
            )}
          </span>

          <div className="ms-auto flex items-center gap-2 sm:ms-0">
            <Button
              variant="secondary"
              onClick={onEdit}
              aria-expanded={editing}
              aria-controls={`agent-editor-${agent.id}`}
            >
              Edit
            </Button>
            <form action={action}>
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
        </div>

        {state.error || capacity.state.error ? (
          <ErrorText inline>{state.error ?? capacity.state.error}</ErrorText>
        ) : null}
      </div>

      {editing ? (
        <AgentEditor agent={agent} groups={groups} isSelf={isSelf} onClose={onClose} />
      ) : null}
    </li>
  );
}
