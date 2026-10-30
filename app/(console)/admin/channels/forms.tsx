'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Notice,
  Select,
  SuccessText,
} from '@/components/ui';
import type { CategoryAiMode } from '@/lib/category-ai/modes';
import { ROUTING_MODES, type RoutingMode } from '@/lib/routing/mode';
import { ROUTING_MODE_LABELS, routingLockReason } from '@/lib/routing/mode-copy';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import {
  isCommentChannel,
  isMetaChannel,
  metaPlatformOf,
  type ConversationChannel,
} from '@/lib/tickets/channel-policy';
import type { AdminState, WebchatSwitchState } from '../settings-shared';
import { saveChannel, setNumberOwner, setWebchatActive } from './actions';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { InfoTip } from '@/components/tooltip';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';
import { CHANNEL_TYPES, channelTypeLabel, isChannelType, type ChannelType } from './channel-types';

const INITIAL: AdminState = { error: null };
const SWITCH_INITIAL: WebchatSwitchState = { error: null };

/**
 * A row as the column stores it, which is a wider set than a form can save.
 *
 * `portal` and `api` channels are created by the product rather than by an
 * admin — the customer portal opens one on first use — and `saveChannel` refuses
 * both. Widening its allowlist to let this form reach them would also let a
 * forged `type` through the add form, so the editor declines them instead.
 */
export type ChannelRow = {
  id: string;
  type: ConversationChannel;
  name: string;
  config: Record<string, unknown>;
  defaultGroupId: string | null;
  whatsappAccountId: string | null;
  /** As saved; `routingModeOf` decides what the router makes of it. */
  routingMode: RoutingMode;
};

function editableType(type: ChannelRow['type']): ChannelType | null {
  return isChannelType(type) ? type : null;
}

type Choice = { id: string; name: string };

const isWhatsAppType = (type: ChannelType) => type === 'whatsapp' || type === 'whatsapp_bot';

export function ChannelForm({
  groups,
  whatsappAccounts,
  classifierMode,
}: {
  groups: Choice[];
  whatsappAccounts: Choice[];
  classifierMode: CategoryAiMode;
}) {
  const { state, key, form } = useActionForm(saveChannel, INITIAL);
  const [type, setType] = useState<ChannelType>('email');

  // Keyed on the last success, so an added channel clears the fields. `type`
  // is above the key and survives, and the select mounts showing it — React's
  // reset, which used to do the clearing, put the select back on Email while
  // the address fields below it still followed the type the admin had chosen.
  return (
    <form
      key={key}
      {...form}
      className="flex flex-col gap-3 rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad)"
    >
      {/* Stacked on a phone, one row from `sm` up. Four controls sharing a
          non-wrapping row left the name box about one character wide, and the
          field that names the channel is the one an admin is actually typing
          into. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Type" className="sm:w-40">
          <Select name="type" value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
            {CHANNEL_TYPES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </Field>

        <NameField className="sm:flex-1" />
        <AddressField type={type} />

        {/* Only for WhatsApp, and only once there is a choice to make: with one
            account connected every number belongs to it, and a picker with a
            single option is a question with one answer. The editor below is not
            allowed the same shortcut — see there. */}
        {isWhatsAppType(type) && whatsappAccounts.length > 0 ? (
          <AccountField accounts={whatsappAccounts} />
        ) : null}

        <GroupField groups={groups} />
      </div>

      {/* A row of its own: five controls already share the one above. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <RoutingModeField type={type} classifierMode={classifierMode} />
      </div>

      <ErrorText>{state.error}</ErrorText>
      <SavedNotice notice={state.notice} />
      <SubmitButton className="self-start" idle="Add channel" busy="Saving…" />
    </form>
  );
}

/**
 * Editing a channel that already exists.
 *
 * The routing on a saved row was write-once until this existed: `saveChannel`
 * has always had an update branch, and nothing in the console could reach it.
 * That made the "no business account" badge on the list a warning with no action
 * behind it — an admin who connected a second WABA could see which number was
 * unassigned and could only fix it by deleting the channel, which orphans every
 * conversation anchored to that row.
 *
 * The type is fixed once a row exists, and is submitted from a hidden field
 * rather than a disabled control, which submits nothing. Changing it is not an
 * edit: `config` has a different shape per type, inbound routing matches on it,
 * and a WhatsApp row turned into an email row would strand every ticket that
 * arrived through it.
 */
export function ChannelEditor({
  channel,
  groups,
  whatsappAccounts,
  classifierMode,
}: {
  channel: ChannelRow;
  groups: Choice[];
  whatsappAccounts: Choice[];
  classifierMode: CategoryAiMode;
}) {
  const { state, form } = useActionForm(saveChannel, INITIAL);
  const [open, setOpen] = useState(false);

  const type = editableType(channel.type);
  // A web chat row is edited here too, but never the widget's own: the page
  // draws `WebchatSettings` for that one, since two forms saving the same
  // group and mode would put each other's stale values back, and `saveChannel`
  // refuses this form on a row a switch has made the widget's since the page
  // was drawn. This form posts no `faqFolder_*` field, and `saveChannel` leaves
  // a row's folders as they are when none is posted, so a rename here keeps
  // what the widget lists once the row becomes the widget's.
  if (!type) return null;
  const connectedThroughMeta = type === 'whatsapp' && parseCoexistence(channel.config) !== null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
      >
        Edit
      </button>
    );
  }

  return (
    <form {...form} className="mt-2 flex w-full flex-col gap-3">
      <input type="hidden" name="id" value={channel.id} />
      <input type="hidden" name="type" value={type} />

      <div className="flex flex-col gap-3 sm:flex-row">
        <NameField className="sm:flex-1" defaultValue={channel.name} />
        <AddressField type={type} config={channel.config} />

        {/* Rendered whenever there is an account at all, unlike the add form
            above: with one connected, an older row can still be pointed at
            nothing, and this is the only screen that can say which one it
            belongs to. `saveChannel` refuses to save it blank anyway.

            Not for a number connected through Meta: it sends with the
            credential stored for the account it was connected to, and
            `saveChannel` refuses to move it. Shown as text, as its phone
            number id is, with the stored id submitted so the save's check
            that it is unchanged passes. */}
        {connectedThroughMeta ? (
          <Field
            label="Business account"
            className="sm:w-44"
            hint="Connected through Meta; reconnect the number to move it to another account."
          >
            <input type="hidden" name="whatsappAccountId" value={channel.whatsappAccountId ?? ''} />
            <Input
              value={
                whatsappAccounts.find((account) => account.id === channel.whatsappAccountId)
                  ?.name ?? 'none — reconnect to set it'
              }
              readOnly
            />
          </Field>
        ) : isWhatsAppType(type) && whatsappAccounts.length > 0 ? (
          <AccountField accounts={whatsappAccounts} defaultValue={channel.whatsappAccountId} />
        ) : null}

        <GroupField groups={groups} defaultValue={channel.defaultGroupId} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <RoutingModeField
          type={type}
          config={channel.config}
          defaultValue={channel.routingMode}
          classifierMode={classifierMode}
        />
      </div>

      <ErrorText>{state.error}</ErrorText>
      <SavedNotice notice={state.notice} />

      <div className="flex items-center gap-3">
        <SubmitButton idle="Save channel" busy="Saving…" />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** An agent a number can be handed to. The address tells apart two people of one name. */
export type OwnerChoice = { id: string; name: string; email: string };

/**
 * The control that hands a WhatsApp number to a team member, or back to the
 * team.
 *
 * A form of its own, posting to `setNumberOwner`, rather than a field in the
 * editor beside it: that editor saves a name and a group, and a handover moves
 * every open ticket on the number, so the two should not share a button.
 *
 * Mounted only while open, as `AdoptBusinessAppNumber` is, so Cancel and a
 * success throw the form's state away with it and reopening starts from the
 * number as it now is rather than from the last refusal. The success's
 * sentence — who owns the number now, and what that did to its tickets —
 * outlives the form, beside the button that reopens it: it is the one place
 * the admin learns that ninety tickets changed hands.
 */
export function OwnerEditor({
  channelId,
  owner,
  agents,
  movableTickets,
}: {
  channelId: string;
  /** As the row records it; `active` false is an owner who can no longer sign in. */
  owner: { id: string; label: string; active: boolean } | null;
  /** Active agents, by name. */
  agents: OwnerChoice[];
  /** Open and pending native tickets on the number: what a handover moves now. */
  movableTickets: number;
}) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (!open) {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
          className="text-xs text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
        >
          {owner ? 'Change owner' : 'Set owner'}
        </button>
        {notice ? (
          <div className="w-full">
            <SuccessText>{notice}</SuccessText>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <OwnerForm
      channelId={channelId}
      owner={owner}
      agents={agents}
      movableTickets={movableTickets}
      onCancel={() => setOpen(false)}
      onDone={(sentence) => {
        setNotice(sentence);
        setOpen(false);
      }}
    />
  );
}

/**
 * The handover itself. The select is uncontrolled and the button is
 * `ConfirmSubmit` — its second click is the moment the admin has read how many
 * tickets go with the number — so the form submits through `useActionForm`,
 * whose refusal leaves the choice standing where React's reset would put the
 * select back on the stored owner (§6.80). Nothing in it takes text, which
 * `ConfirmSubmit` needs: Enter in a text box would submit past the
 * confirmation.
 *
 * It opens on the number's current owner, so the select starts on what the
 * number has rather than on "Nobody", and a second click nobody meant leaves
 * it as it was. An owner the list of active agents leaves out — deactivated,
 * which is the case the row warns about — is offered under their own name for
 * that reason. Choosing them again is refused by the lib with the way out;
 * clearing the number is a deliberate choice of "Nobody" on screen.
 */
function OwnerForm({
  channelId,
  owner,
  agents,
  movableTickets,
  onCancel,
  onDone,
}: {
  channelId: string;
  owner: { id: string; label: string; active: boolean } | null;
  agents: OwnerChoice[];
  movableTickets: number;
  onCancel: () => void;
  onDone: (notice: string | null) => void;
}) {
  // `: void` by hand: the handler reads the state this same call returns, and
  // TypeScript cannot infer a return type through that loop.
  const { state, form } = useActionForm(setNumberOwner, INITIAL, {
    onSuccess: (): void => onDone(state.notice ?? null),
  });

  const listed = owner === null || agents.some((agent) => agent.id === owner.id);

  return (
    <form {...form} className="mt-2 flex w-full flex-col gap-3">
      <input type="hidden" name="channelId" value={channelId} />

      <Field
        label="Owner"
        className="sm:w-96"
        explain={
          <>
            The team member who answers this number from the phone. New tickets on it are assigned
            to them, and every ticket on it counts against them for its SLA, whoever it is later
            reassigned to. Nobody makes it a team number: its default group&rsquo;s rota assigns new
            tickets, and each ticket counts against whoever holds it.
          </>
        }
        hint={movesHint(movableTickets)}
      >
        {/* Named outright: `Field` puts its InfoTip button inside the label,
            and a label with no `for` names its first labelable descendant —
            the button — so the select would reach a screen reader unnamed. */}
        <Select name="ownerAgentId" defaultValue={owner?.id ?? ''} aria-label="Owner">
          <option value="">Nobody — team number</option>
          {owner && !listed ? (
            <option value={owner.id}>
              {owner.active ? owner.label : `${owner.label} (deactivated)`}
            </option>
          ) : null}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {`${agent.name} — ${agent.email}`}
            </option>
          ))}
        </Select>
      </Field>

      <ErrorText>{state.error}</ErrorText>

      <div className="flex items-center gap-3">
        <ConfirmSubmit
          label="Hand over"
          confirmLabel={
            movableTickets === 0
              ? 'Really hand over?'
              : `Hand over with ${movableTickets} ${movableTickets === 1 ? 'ticket' : 'tickets'}?`
          }
          busy="Handing over…"
        />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * What a handover does to the number's tickets, under the picker: said before
 * the second click, because afterwards it has happened. The count is
 * `movesWithNumber`'s, so it is the set the handover then moves. Worded for
 * both choices, because the select is uncontrolled and the hint cannot follow
 * it: choosing Nobody moves the tickets' accountability and none of their work.
 */
function movesHint(count: number): string {
  const resolved =
    'A resolved ticket follows only if it is reopened. Choosing Nobody leaves every ticket with whoever holds it, and each counts against them.';
  if (count === 0) return `It has no open or pending tickets now. ${resolved}`;
  if (count === 1) {
    return `Its 1 open or pending ticket goes with it: from now it counts against the new owner, and is reassigned to them if the current owner or nobody holds it. ${resolved}`;
  }
  return `Its ${count} open or pending tickets go with it: from now they count against the new owner, and those the current owner or nobody holds are reassigned to them. ${resolved}`;
}

function NameField({ className, defaultValue }: { className?: string; defaultValue?: string }) {
  return (
    <Field label="Name" className={className}>
      <Input name="name" defaultValue={defaultValue} placeholder="Support mailbox" required />
    </Field>
  );
}

/** Whatever addresses this channel, which is a different thing on each of them. */
function AddressField({ type, config }: { type: ChannelType; config?: Record<string, unknown> }) {
  if (type === 'webchat') {
    return (
      <p className="text-xs text-(--color-text-secondary) sm:flex-1 sm:pt-6">
        The widget needs no address — only a default group.
      </p>
    );
  }

  // A number connected through Meta's window has its id from Meta, not from a
  // form, and `saveChannel` keeps the stored one whatever is submitted. Shown
  // as text rather than as a box that would appear to accept a change.
  if (type === 'whatsapp' && config && parseCoexistence(config)) {
    return (
      <Field
        label="Phone number ID"
        className="sm:flex-1"
        hint="Reported by Meta when the number was connected; it is not edited here."
      >
        <Input name="phoneNumberId" value={(config.phoneNumberId as string) ?? ''} readOnly />
      </Field>
    );
  }

  if (isWhatsAppType(type)) {
    return (
      <Field
        label="Phone number ID"
        className="sm:flex-1"
        explain={
          <>
            Meta&rsquo;s numeric id for the WhatsApp number, copied from the WhatsApp Manager — not
            the phone number itself. Inbound messages are matched to this channel by it, so a wrong
            one means webhooks arrive and route nowhere.
          </>
        }
      >
        <Input
          name="phoneNumberId"
          defaultValue={(config?.phoneNumberId as string) ?? ''}
          placeholder="1234567890"
        />
      </Field>
    );
  }

  if (isMetaChannel(type)) {
    // The page and account ids live in the environment, because they are paired
    // with a token that must never be in the database. This row is routing only:
    // which group a message from here lands in. A comments row rides the same
    // Page or account as its platform's row, so it names the same variable.
    const platform = metaPlatformOf(type);
    const variable = platform === 'facebook' ? 'FACEBOOK_PAGE_ID' : 'INSTAGRAM_ACCOUNT_ID';
    return (
      <p className="text-xs text-(--color-text-secondary) sm:flex-1 sm:pt-6">
        {isCommentChannel(type)
          ? `Public comments on the posts of the account configured by ${variable} in the environment. The oldest active comments row sets their default group, “None” included; until one exists they start in the ${channelTypeLabel(platform)} row’s group.`
          : `Configured by ${variable} in the environment. This row only sets the default group.`}
      </p>
    );
  }

  return (
    <Field label="Address" className="sm:flex-1">
      <Input
        name="address"
        type="email"
        defaultValue={(config?.address as string) ?? ''}
        placeholder="support@shipblu.com"
      />
    </Field>
  );
}

function AccountField({
  accounts,
  defaultValue,
}: {
  accounts: Choice[];
  defaultValue?: string | null;
}) {
  return (
    <Field
      label="Business account"
      className="sm:w-44"
      explain={
        <>
          Which WABA this number belongs to. It decides the access token the reply is sent with and
          the set of templates an agent may pick from — a template approved on another business
          account is rejected by Meta on a status webhook, long after the agent was told the message
          went.
        </>
      }
    >
      <Select name="whatsappAccountId" defaultValue={defaultValue ?? accounts[0]?.id ?? ''}>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function GroupField({ groups, defaultValue }: { groups: Choice[]; defaultValue?: string | null }) {
  return (
    <Field
      label="Default group"
      className="sm:w-40"
      explain={
        <>
          Which group a ticket from this channel starts in, before any automation moves it. With
          none, it arrives in no group at all and waits in the unassigned queue for somebody to pick
          it up.
        </>
      }
    >
      <Select name="defaultGroupId" defaultValue={defaultValue ?? ''}>
        <option value="">None</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}
/**
 * How a channel's new tickets find their group, on every form that saves a
 * channel row.
 *
 * Uncontrolled, and absent from the submission wherever the mode cannot
 * change: `saveChannel` reads a missing `routingMode` as "unchanged", so a
 * row that can never route — a number on the Business app, the bot — shows a
 * disabled select (which submits nothing) with the reason under it, rather
 * than no control at all, which would leave an admin wondering where it went.
 * The reason is `routingLockReason`'s, the sentence the action refuses with.
 *
 * The hint names an idle classifier whatever is selected: the select is
 * uncontrolled, so a hint following it would need state the form-reset rules
 * are written to keep out of these forms.
 */
function RoutingModeField({
  type,
  config,
  defaultValue = 'default_group',
  classifierMode,
  className = 'sm:w-56',
}: {
  type: ChannelType;
  config?: Record<string, unknown>;
  defaultValue?: RoutingMode;
  classifierMode: CategoryAiMode;
  className?: string;
}) {
  const locked = routingLockReason({ type, config: config ?? {} });
  const idle =
    classifierMode === 'apply'
      ? undefined
      : `Both category modes hold and record nothing until the category classifier is in Apply on /admin/categories; it is ${classifierMode === 'off' ? 'off' : 'in Shadow'} now.`;

  return (
    <Field
      label="Routing"
      className={className}
      hint={locked ?? idle}
      explain={
        <>
          How a new ticket from this channel finds its group. <strong>Default group</strong>: it
          starts in the default group and is assigned there, as always. <strong>By category</strong>
          : assignment and the out-of-hours reply wait for the routing window set on the Categories
          page while the category classifier files the ticket, which then moves once, to its
          category&rsquo;s route group — an automation rule that assigns or moves the ticket first
          decides instead. <strong>By category — shadow</strong>: nothing waits or moves; where each
          ticket would have gone is recorded, to compare with what the team did. Both category modes
          need the classifier in Apply. A number on the WhatsApp Business app and the customer bot
          never route.
        </>
      }
    >
      {/* Named outright: `Field` puts its InfoTip button inside the label, and
          a label with no `for` names its first labelable descendant — the
          button — so the select would reach a screen reader unnamed. Keyed on
          which of the two it is, so the add form switching to the bot and
          back starts the open one again rather than reusing the element. */}
      {locked ? (
        <Select key="locked" aria-label="Routing" defaultValue="default_group" disabled>
          <option value="default_group">{ROUTING_MODE_LABELS.default_group}</option>
        </Select>
      ) : (
        <Select key="open" name="routingMode" aria-label="Routing" defaultValue={defaultValue}>
          {ROUTING_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {ROUTING_MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/**
 * What a save has to say beyond succeeding — that the mode it saved is idle —
 * rendered from the answer rather than inside the fields, so the add form's
 * remount on success does not take it away.
 */
function SavedNotice({ notice }: { notice?: string }) {
  if (!notice) return null;
  return (
    <Notice tone="warning" icon>
      {notice}
    </Notice>
  );
}

export type FaqFolderChoice = {
  id: string;
  name: string;
  categoryName: string;
  categoryLocale: string;
};

/**
 * The chat widget's settings, on the row that already routes it.
 *
 * The widget opens on a short list of questions rather than on an empty
 * composer, and this is where an editor says which questions. A folder rather
 * than a free list because the knowledge base already has the ordering — an
 * editor drags articles within a folder — so pointing at one keeps a single
 * place to curate instead of a second list here that drifts from it.
 *
 * Only public folders are offered. The widget reads with an anonymous viewer, so
 * an `agents_only` folder would save cleanly and then show a customer nothing;
 * the action refuses one too, because this list is a convenience and not a
 * control.
 */
export function WebchatSettings({
  channel,
  groups,
  folders,
  classifierMode,
}: {
  channel: {
    id: string;
    name: string;
    defaultGroupId: string | null;
    faqFolders: Record<string, string>;
    routingMode: RoutingMode;
  };
  groups: { id: string; name: string }[];
  folders: FaqFolderChoice[];
  classifierMode: CategoryAiMode;
}) {
  const { state, form } = useActionForm(saveChannel, INITIAL);
  const [editing, setEditing] = useState(false);

  const chosen = (['ar', 'en'] as const)
    .map((locale) => folders.find((folder) => folder.id === channel.faqFolders[locale]))
    .filter((folder): folder is FaqFolderChoice => Boolean(folder));

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Chat widget
            {/* Which row, because there can be more than one: the widget reads
                the oldest active, and this card follows it. */}
            <span className="font-normal text-(--color-text-secondary)">
              on &ldquo;<span dir="auto">{channel.name}</span>&rdquo;
            </span>
            {chosen.length === 0 ? <Badge tone="warning">No questions chosen</Badge> : null}
          </h3>
          <p className="mt-0.5 text-xs text-(--color-text-secondary)">
            {chosen.length === 0
              ? 'The widget lists the most-read articles until a folder is chosen here.'
              : chosen.map((folder) => `${folder.categoryLocale}: ${folder.name}`).join(' · ')}
          </p>
        </div>
        <Button variant="secondary" onClick={() => setEditing(true)}>
          Configure
        </Button>
      </div>
    );
  }

  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={channel.id} />
      <input type="hidden" name="type" value="webchat" />

      {/* The widget's row is edited here rather than by the row editor in the
          list, so its name is too. */}
      <NameField className="sm:w-72" defaultValue={channel.name} />

      <div className="grid gap-3 sm:grid-cols-2">
        {(['ar', 'en'] as const).map((locale) => (
          <Field
            key={locale}
            label={locale === 'ar' ? 'Arabic questions' : 'English questions'}
            explain={
              <>
                The folder whose articles the widget lists, in the order the knowledge base editor
                put them in. A folder has no language of its own — it takes its category&rsquo;s —
                so each language is chosen separately. With none chosen the widget falls back to the
                most-read articles, which is a reasonable list but nobody&rsquo;s decision.
              </>
            }
          >
            <Select name={`faqFolder_${locale}`} defaultValue={channel.faqFolders[locale] ?? ''}>
              <option value="">Most-read articles</option>
              {folders
                .filter((folder) => folder.categoryLocale === locale)
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.categoryName} → {folder.name}
                  </option>
                ))}
            </Select>
          </Field>
        ))}
      </div>

      {/* Carried through because `saveChannel` writes the whole row: leaving it
          out would silently un-route web chat while an admin was choosing which
          articles to show. */}
      <Field
        label="Default group"
        className="sm:w-56"
        explain={
          <>
            Which group a chat starts in — and, because the widget reads that group&rsquo;s
            schedule, the hours it calls &ldquo;we are here&rdquo;.
          </>
        }
      >
        <Select name="defaultGroupId" defaultValue={channel.defaultGroupId ?? ''}>
          <option value="">None</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </Select>
      </Field>

      {/* Carried for the same reason, though an absent mode would only be
          left as it is: a control missing from one of the three forms that
          save this row is a setting the widget's own screen cannot show. */}
      <RoutingModeField
        type="webchat"
        defaultValue={channel.routingMode}
        classifierMode={classifierMode}
        className="sm:w-56"
      />

      <ErrorText>{state.error}</ErrorText>
      <SavedNotice notice={state.notice} />

      <div className="flex gap-2">
        <SubmitButton idle="Save widget" busy="Saving…" />
        <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * What switching a web chat row would do, as the page worked it out from the
 * rows it drew (`webchatSwitch`), carrying names rather than rows into the
 * browser.
 */
export type WebchatSwitchView =
  | { kind: 'only_row' }
  | { kind: 'switch_off'; widgetMovesTo: string | null }
  | { kind: 'switch_on'; takesWidget: boolean };

/**
 * A web chat row's active switch.
 *
 * Its own form posting to `setWebchatActive`, with nothing in it but the row
 * and the direction, so `ConfirmSubmit` may sit in it: the row editor beside it
 * holds a text box, where Enter would submit past a confirmation. The second
 * click is the one that says where the widget goes, since a switch either way
 * can move it: off on the widget's own row, on for a row older than the
 * widget's. The page's wording is a forecast; the action decides again under
 * its lock and says what happened, which is what stays on screen. Through
 * `useActionForm`, though a reset moves nothing here, so an action that throws
 * is a sentence beside the button rather than the console's error page.
 *
 * Each row's switch keeps its own notice, and the notice is about where the
 * widget went, so it is shown only while the widget is still on the row it
 * names (`widgetId`): a later switch that moves the widget makes every earlier
 * notice untrue. A row the switch left as the only active one draws its line
 * saying why it stays on, with the notice under it all the same.
 */
export function WebchatActiveSwitch({
  channelId,
  plan,
  widgetId,
}: {
  channelId: string;
  plan: WebchatSwitchView;
  widgetId: string | null;
}) {
  const { state, form } = useActionForm(setWebchatActive, SWITCH_INITIAL);
  const notice = state.notice && state.widgetId === widgetId ? state.notice : null;

  // The notice outlives the form's place in the row, on a line of its own as
  // the owner handover's does: it says where the widget went, which is the
  // sentence the admin needs, and inside the form it squeezed the button off
  // its line.
  const noticeLine = notice ? (
    <div className="w-full">
      <SuccessText>{notice}</SuccessText>
    </div>
  ) : null;

  if (plan.kind === 'only_row') {
    return (
      <>
        <span className="inline-flex items-center gap-1 text-xs text-(--color-text-secondary)">
          The only active web chat row
          <InfoTip label="why this row stays on">
            The widget needs an active web chat row: without one its chats are filed under no row
            and no group, and it shows the default opening hours. Switch another web chat row on, or
            add one, to switch this one off.
          </InfoTip>
        </span>
        {noticeLine}
      </>
    );
  }

  const on = plan.kind === 'switch_on';
  const confirmLabel = on
    ? plan.takesWidget
      ? 'Move the widget to this row?'
      : 'Really switch on?'
    : plan.widgetMovesTo
      ? `Move the widget to “${plan.widgetMovesTo}”?`
      : 'Really switch off?';

  return (
    <>
      <form {...form} className="inline-flex flex-col items-end gap-1">
        <input type="hidden" name="id" value={channelId} />
        <input type="hidden" name="active" value={on ? 'on' : 'off'} />
        <ConfirmSubmit label={on ? 'Switch on' : 'Switch off'} confirmLabel={confirmLabel} />
        {state.error ? (
          <span className="max-w-xs text-end">
            <ErrorText inline>{state.error}</ErrorText>
          </span>
        ) : null}
      </form>
      {noticeLine}
    </>
  );
}
