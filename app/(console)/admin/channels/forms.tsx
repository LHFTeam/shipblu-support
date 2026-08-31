'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorText, Field, Input, Select } from '@/components/ui';
import { saveChannel, type AdminState } from '../actions';

const INITIAL: AdminState = { error: null };

type ChannelType = 'email' | 'whatsapp' | 'webchat' | 'facebook' | 'instagram' | 'whatsapp_bot';

export function ChannelForm({
  groups,
  whatsappAccounts,
}: {
  groups: { id: string; name: string }[];
  whatsappAccounts: { id: string; name: string }[];
}) {
  const [state, action] = useActionState(saveChannel, INITIAL);
  const [type, setType] = useState<ChannelType>('email');
  const isWhatsApp = type === 'whatsapp' || type === 'whatsapp_bot';

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

        <Field label="Name" className="sm:flex-1">
          <Input name="name" placeholder="Support mailbox" required />
        </Field>

        <div className="sm:flex-1">
          {type === 'webchat' ? (
            <p className="text-xs text-[var(--muted-foreground)] sm:pt-6">
              The widget needs no address — only a default group.
            </p>
          ) : isWhatsApp ? (
            <Field
              label="Phone number ID"
              explain={
                <>
                  Meta&rsquo;s numeric id for the WhatsApp number, copied from the WhatsApp Manager
                  — not the phone number itself. Inbound messages are matched to this channel by it,
                  so a wrong one means webhooks arrive and route nowhere.
                </>
              }
            >
              <Input name="phoneNumberId" placeholder="1234567890" />
            </Field>
          ) : type === 'facebook' || type === 'instagram' ? (
            // The page and account ids live in the environment, because they are
            // paired with a token that must never be in the database. This row
            // is routing only: which group a message from here lands in.
            <p className="text-xs text-[var(--muted-foreground)] sm:pt-6">
              Configured by {type === 'facebook' ? 'FACEBOOK_PAGE_ID' : 'INSTAGRAM_ACCOUNT_ID'} in
              the environment. This row only sets the default group.
            </p>
          ) : (
            <Field label="Address">
              <Input name="address" type="email" placeholder="support@shipblu.com" />
            </Field>
          )}
        </div>

        {/* Only for WhatsApp, and only once there is a choice to make: with one
            account connected every number belongs to it, and a picker with a
            single option is a question with one answer. */}
        {isWhatsApp && whatsappAccounts.length > 0 ? (
          <Field
            label="Business account"
            className="sm:w-44"
            explain={
              <>
                Which WABA this number belongs to. It decides the access token the reply is sent
                with and the set of templates an agent may pick from — a template approved on
                another business account is rejected by Meta on a status webhook, long after the
                agent was told the message went.
              </>
            }
          >
            <Select name="whatsappAccountId" defaultValue={whatsappAccounts[0]?.id ?? ''}>
              {whatsappAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field
          label="Default group"
          className="sm:w-40"
          explain={
            <>
              Which group a ticket from this channel starts in, before any automation moves it. With
              none, it arrives in no group at all and waits in the unassigned queue for somebody to
              pick it up.
            </>
          }
        >
          <Select name="defaultGroupId" defaultValue="">
            <option value="">None</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <ErrorText>{state.error}</ErrorText>
      <SubmitButton className="self-start" idle="Add channel" busy="Saving…" />
    </form>
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
