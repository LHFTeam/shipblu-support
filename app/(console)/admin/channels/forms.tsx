'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Select } from '@/components/ui';
import { createGroup, saveChannel, type AdminState } from '../actions';

const INITIAL: AdminState = { error: null };

export function ChannelForm({ groups }: { groups: { id: string; name: string }[] }) {
  const [state, action] = useActionState(saveChannel, INITIAL);
  const [type, setType] = useState<'email' | 'whatsapp'>('email');

  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      <div className="flex gap-3">
        <div className="w-40">
          <Label htmlFor="type">Type</Label>
          <Select
            id="type"
            name="type"
            value={type}
            onChange={(e) => setType(e.target.value as 'email' | 'whatsapp')}
          >
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </Select>
        </div>

        <div className="flex-1">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" placeholder="Support mailbox" required />
        </div>

        <div className="flex-1">
          {type === 'whatsapp' ? (
            <>
              <Label htmlFor="phoneNumberId">Phone number ID</Label>
              <Input id="phoneNumberId" name="phoneNumberId" placeholder="1234567890" />
            </>
          ) : (
            <>
              <Label htmlFor="address">Address</Label>
              <Input id="address" name="address" type="email" placeholder="support@shipblu.com" />
            </>
          )}
        </div>

        <div className="w-40">
          <Label htmlFor="defaultGroupId">Default group</Label>
          <Select id="defaultGroupId" name="defaultGroupId" defaultValue="">
            <option value="">None</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <ErrorText>{state.error}</ErrorText>
      <SubmitButton className="self-start" idle="Add channel" busy="Saving…" />
    </form>
  );
}

export function GroupForm() {
  const [state, action] = useActionState(createGroup, INITIAL);

  return (
    <form
      action={action}
      className="flex items-end gap-3 rounded-lg border border-[var(--border)] p-4"
    >
      <div className="flex-1">
        <Label htmlFor="groupName">Group name</Label>
        <Input id="groupName" name="name" placeholder="Deliveries" required />
      </div>
      <SubmitButton idle="Add group" busy="Saving…" />
      <ErrorText>{state.error}</ErrorText>
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
