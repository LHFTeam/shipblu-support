'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Field, Input, Select } from '@/components/ui';
import { saveChannel, type AdminState } from '../actions';

const INITIAL: AdminState = { error: null };

type ChannelType = 'email' | 'whatsapp' | 'webchat' | 'facebook' | 'instagram' | 'whatsapp_bot';

export function ChannelForm({ groups }: { groups: { id: string; name: string }[] }) {
  const [state, action] = useActionState(saveChannel, INITIAL);
  const [type, setType] = useState<ChannelType>('email');

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      <div className="flex gap-3">
        <Field label="Type" className="w-40">
          <Select name="type" value={type} onChange={(e) => setType(e.target.value as ChannelType)}>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="webchat">Web chat</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="whatsapp_bot">WhatsApp — customer bot</option>
          </Select>
        </Field>

        <Field label="Name" className="flex-1">
          <Input name="name" placeholder="Support mailbox" required />
        </Field>

        <div className="flex-1">
          {type === 'webchat' ? (
            <p className="pt-6 text-xs text-[var(--muted-foreground)]">
              The widget needs no address — only a default group.
            </p>
          ) : type === 'whatsapp' || type === 'whatsapp_bot' ? (
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
            <p className="pt-6 text-xs text-[var(--muted-foreground)]">
              Configured by {type === 'facebook' ? 'FACEBOOK_PAGE_ID' : 'INSTAGRAM_ACCOUNT_ID'} in
              the environment. This row only sets the default group.
            </p>
          ) : (
            <Field label="Address">
              <Input name="address" type="email" placeholder="support@shipblu.com" />
            </Field>
          )}
        </div>

        <Field
          label="Default group"
          className="w-40"
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
