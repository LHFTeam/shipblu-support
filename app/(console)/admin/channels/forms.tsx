'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorText, Field, Input, Select } from '@/components/ui';
import { saveChannel, type AdminState } from '../actions';

const INITIAL: AdminState = { error: null };

/** The types a form may create or save. Must match the list `saveChannel` accepts. */
const EDITABLE = ['email', 'whatsapp', 'webchat', 'facebook', 'instagram', 'whatsapp_bot'] as const;

type ChannelType = (typeof EDITABLE)[number];

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
  type: ChannelType | 'portal' | 'api';
  name: string;
  config: Record<string, unknown>;
  defaultGroupId: string | null;
  whatsappAccountId: string | null;
};

function editableType(type: ChannelRow['type']): ChannelType | null {
  return (EDITABLE as readonly string[]).includes(type) ? (type as ChannelType) : null;
}

type Choice = { id: string; name: string };

const isWhatsAppType = (type: ChannelType) => type === 'whatsapp' || type === 'whatsapp_bot';

export function ChannelForm({
  groups,
  whatsappAccounts,
}: {
  groups: Choice[];
  whatsappAccounts: Choice[];
}) {
  const [state, action] = useActionState(saveChannel, INITIAL);
  const [type, setType] = useState<ChannelType>('email');

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      {/* Stacked on a phone, one row from `sm` up. Four controls sharing a
          non-wrapping row left the name box about one character wide, and the
          field that names the channel is the one an admin is actually typing
          into. */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Field label="Type" className="sm:w-40">
          <Select name="type" value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="webchat">Web chat</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="whatsapp_bot">WhatsApp — customer bot</option>
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

      <ErrorText>{state.error}</ErrorText>
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
}: {
  channel: ChannelRow;
  groups: Choice[];
  whatsappAccounts: Choice[];
}) {
  const [state, action] = useActionState(saveChannel, INITIAL);
  const [open, setOpen] = useState(false);

  const type = editableType(channel.type);
  // Web chat is edited by `WebchatSettings` below the list, and must not be
  // edited here: `saveChannel` rebuilds a webchat row's config from the
  // `faqFolder_*` fields, and this form has none, so saving the name from here
  // would silently clear the folders the widget lists.
  if (!type || type === 'webchat') return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-brand-600 hover:underline"
      >
        Edit
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 flex w-full flex-col gap-3">
      <input type="hidden" name="id" value={channel.id} />
      <input type="hidden" name="type" value={type} />

      <div className="flex flex-col gap-3 sm:flex-row">
        <NameField className="sm:flex-1" defaultValue={channel.name} />
        <AddressField type={type} config={channel.config} />

        {/* Rendered whenever there is an account at all, unlike the add form
            above: with one connected, an older row can still be pointed at
            nothing, and this is the only screen that can say which one it
            belongs to. `saveChannel` refuses to save it blank anyway. */}
        {isWhatsAppType(type) && whatsappAccounts.length > 0 ? (
          <AccountField accounts={whatsappAccounts} defaultValue={channel.whatsappAccountId} />
        ) : null}

        <GroupField groups={groups} defaultValue={channel.defaultGroupId} />
      </div>

      <ErrorText>{state.error}</ErrorText>

      <div className="flex items-center gap-3">
        <SubmitButton idle="Save channel" busy="Saving…" />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
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
      <p className="text-xs text-[var(--muted-foreground)] sm:flex-1 sm:pt-6">
        The widget needs no address — only a default group.
      </p>
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

  if (type === 'facebook' || type === 'instagram') {
    // The page and account ids live in the environment, because they are paired
    // with a token that must never be in the database. This row is routing only:
    // which group a message from here lands in.
    return (
      <p className="text-xs text-[var(--muted-foreground)] sm:flex-1 sm:pt-6">
        Configured by {type === 'facebook' ? 'FACEBOOK_PAGE_ID' : 'INSTAGRAM_ACCOUNT_ID'} in the
        environment. This row only sets the default group.
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
}: {
  channel: {
    id: string;
    name: string;
    defaultGroupId: string | null;
    faqFolders: Record<string, string>;
  };
  groups: { id: string; name: string }[];
  folders: FaqFolderChoice[];
}) {
  const [state, action] = useActionState(saveChannel, INITIAL);
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
            {chosen.length === 0 ? <Badge tone="warning">no questions chosen</Badge> : null}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
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
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={channel.id} />
      <input type="hidden" name="type" value="webchat" />
      <input type="hidden" name="name" value={channel.name} />

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

      <ErrorText>{state.error}</ErrorText>

      <div className="flex gap-2">
        <SubmitButton idle="Save widget" busy="Saving…" />
        <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
