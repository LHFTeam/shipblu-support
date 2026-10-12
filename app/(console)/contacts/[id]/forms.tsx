'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { XIcon } from '@/components/icons';
import { Badge, Button, ErrorText, Input } from '@/components/ui';
import { useActionForm } from '@/components/use-action-form';
import type { LinkedShippingAccount } from '@/lib/shipments/queries';
import {
  linkContactToAccount,
  setContactRoles,
  unlinkContactFromAccount,
  type ContactActionState,
} from '../actions';

const INITIAL: ContactActionState = { error: null };

/**
 * The manual half of designating a contact as a shipper, a recipient, or both.
 *
 * Saved on change with no button, matching the ticket sidebar. Both can be on:
 * a merchant who also takes returns is both, and that is the common case for
 * anyone who ships at all.
 */
export function RoleToggles({
  contactId,
  isShipper,
  isRecipient,
}: {
  contactId: string;
  isShipper: boolean;
  isRecipient: boolean;
}) {
  const [shipper, setShipper] = useState(isShipper);
  const [recipient, setRecipient] = useState(isRecipient);
  const [error, setError] = useState<string | null>(null);

  async function save(next: { shipper: boolean; recipient: boolean }) {
    const formData = new FormData();
    formData.set('contactId', contactId);
    if (next.shipper) formData.set('isShipper', 'on');
    if (next.recipient) formData.set('isRecipient', 'on');

    const result = await setContactRoles(INITIAL, formData);
    setError(result.error);
  }

  return (
    <div>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={shipper}
            onChange={(event) => {
              setShipper(event.target.checked);
              void save({ shipper: event.target.checked, recipient });
            }}
            className="size-4 accent-(--color-control-accent)"
          />
          Shipper
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={recipient}
            onChange={(event) => {
              setRecipient(event.target.checked);
              void save({ shipper, recipient: event.target.checked });
            }}
            className="size-4 accent-(--color-control-accent)"
          />
          Recipient
        </label>
      </div>
      {error ? (
        <p className="mt-2">
          <ErrorText inline>{error}</ErrorText>
        </p>
      ) : null}
    </div>
  );
}

export function AccountLinks({
  contactId,
  accounts,
  editable,
}: {
  contactId: string;
  accounts: LinkedShippingAccount[];
  editable: boolean;
}) {
  const router = useRouter();
  const { state, key, form, pending } = useActionForm(linkContactToAccount, INITIAL);
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(shippingAccountId: string) {
    setRemoving(shippingAccountId);
    const formData = new FormData();
    formData.set('contactId', contactId);
    formData.set('shippingAccountId', shippingAccountId);
    const result = await unlinkContactFromAccount(INITIAL, formData);
    setRemoving(null);
    // A success brings the re-read page with it. A refusal is not shown and
    // revalidates nothing; the one an agent can meet is a permission lost since
    // the page was drawn, and re-reading takes the × buttons away rather than
    // leaving them doing nothing.
    if (result.error) router.refresh();
  }

  return (
    <div>
      <ul className="mb-3 flex flex-col gap-1.5 text-sm">
        {accounts.map((account) => (
          <li key={account.shippingAccountId} className="flex items-center justify-between gap-2">
            <Link
              href={`/contacts/accounts/${encodeURIComponent(account.sbid)}`}
              className="font-medium hover:underline"
            >
              {account.sbid}
            </Link>
            <div className="flex items-center gap-1">
              {account.name ? (
                <span className="text-xs text-(--color-text-secondary)">{account.name}</span>
              ) : null}
              {account.linkSource === 'platform' ? <Badge>Platform</Badge> : null}
              {editable ? (
                <button
                  type="button"
                  disabled={removing === account.shippingAccountId}
                  onClick={() => void remove(account.shippingAccountId)}
                  aria-label={`Remove ${account.sbid}`}
                  className="flex size-6 items-center justify-center rounded-md text-(--color-text-tertiary) hover:bg-(--color-background-hover) hover:text-(--color-text-primary) disabled:opacity-50"
                >
                  <XIcon size={14} />
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {accounts.length === 0 ? (
          <li className="text-xs text-(--color-text-tertiary)">
            None. A mention in a chat does not count.
          </li>
        ) : null}
      </ul>

      {editable ? (
        // No refresh of its own: `linkContactToAccount` revalidates this page,
        // so the action's answer already carries it, and a refresh fired from
        // the submit ran before the action answered and after a refusal too.
        <form key={key} {...form} className="flex gap-2">
          <input type="hidden" name="contactId" value={contactId} />
          <Input
            name="sbid"
            placeholder="Add an SBID"
            aria-label="Add an SBID"
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={pending}
            loading={pending}
            className="shrink-0"
          >
            Add
          </Button>
        </form>
      ) : null}

      {state.error ? <ErrorText>{state.error}</ErrorText> : null}
    </div>
  );
}
