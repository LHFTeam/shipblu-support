'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, ErrorText } from '@/components/ui';
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
  const router = useRouter();
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
    if (!result.error) router.refresh();
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
            className="size-4 accent-[var(--brand-600,#1e40af)]"
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
            className="size-4 accent-[var(--brand-600,#1e40af)]"
          />
          Recipient
        </label>
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
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
    await unlinkContactFromAccount(INITIAL, formData);
    setRemoving(null);
    router.refresh();
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
              {account.name ? <span className="text-xs opacity-60">{account.name}</span> : null}
              {account.linkSource === 'platform' ? <Badge>platform</Badge> : null}
              {editable ? (
                <button
                  type="button"
                  disabled={removing === account.shippingAccountId}
                  onClick={() => void remove(account.shippingAccountId)}
                  aria-label={`Remove ${account.sbid}`}
                  className="rounded px-1 text-xs opacity-50 hover:opacity-100"
                >
                  &times;
                </button>
              ) : null}
            </div>
          </li>
        ))}
        {accounts.length === 0 ? (
          <li className="text-xs opacity-50">None. A mention in a chat does not count.</li>
        ) : null}
      </ul>

      {editable ? (
        // No refresh of its own: `linkContactToAccount` revalidates this page,
        // so the action's answer already carries it, and a refresh fired from
        // the submit ran before the action answered and after a refusal too.
        <form key={key} {...form} className="flex gap-2">
          <input type="hidden" name="contactId" value={contactId} />
          <input
            name="sbid"
            placeholder="Add an SBID"
            aria-label="Add an SBID"
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            disabled={pending}
            className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs hover:bg-[var(--muted)]"
          >
            Add
          </button>
        </form>
      ) : null}

      {state.error ? <ErrorText>{state.error}</ErrorText> : null}
    </div>
  );
}
