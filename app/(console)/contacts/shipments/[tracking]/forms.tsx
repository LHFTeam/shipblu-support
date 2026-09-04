'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { refreshShipmentDetail, setShipmentParty, type ContactActionState } from '../../actions';

const INITIAL: ContactActionState = { error: null };

/**
 * Naming one end of a parcel.
 *
 * This is the honest form of "designate contacts as shippers or recipients":
 * the role is recorded against the shipment, where it actually lives, so every
 * ticket about this parcel derives the same answer. Recording it per ticket
 * would let two tickets about one shipment disagree.
 *
 * A contact id rather than a picker, deliberately. There is no contact search
 * component yet and inventing one here would be the third search box in this
 * feature; the id is copied from the contact page, which an agent is on anyway
 * when they work out who this is.
 */
export function PartyField({
  trackingNumber,
  party,
  current,
  editable,
}: {
  trackingNumber: string;
  party: 'shipper' | 'recipient';
  current: { id: string; name: string | null; handle: string | null } | null;
  editable: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(contactId: string) {
    setBusy(true);
    const formData = new FormData();
    formData.set('trackingNumber', trackingNumber);
    formData.set('party', party);
    formData.set('contactId', contactId);

    const result = await setShipmentParty(INITIAL, formData);
    setBusy(false);
    setError(result.error);

    if (!result.error) {
      setValue('');
      router.refresh();
    }
  }

  return (
    <div>
      {current ? (
        <div className="mb-2 text-sm">
          <Link href={`/contacts/${current.id}`} className="font-medium hover:underline">
            {current.name ?? 'Unnamed'}
          </Link>
          {current.handle ? (
            <p className="text-xs text-[var(--muted-foreground)]">{current.handle}</p>
          ) : null}
        </div>
      ) : (
        <p className="mb-2 text-xs opacity-50">Not named.</p>
      )}

      {editable ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Contact id"
              aria-label={`Set the ${party}`}
              className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs outline-none focus:border-brand-500"
            />
            <button
              type="button"
              disabled={busy || !value.trim()}
              onClick={() => void save(value.trim())}
              className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs hover:bg-[var(--muted)] disabled:opacity-40"
            >
              Set
            </button>
          </div>

          {current ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void save('')}
              className="self-start text-xs opacity-60 hover:opacity-100"
            >
              Clear
            </button>
          ) : null}

          {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Fetch latest" for the shipment page.
 *
 * Says when the parcel was last read, for the reason the ticket sidebar's twin
 * does: a status with no date beside it invites an agent to repeat it to a
 * customer as though it were current.
 *
 * Available to anyone who can view the page rather than only to editors — the
 * action gates on `contact.view` — because the read-only agent answering the
 * phone is exactly who needs it.
 */
export function RefreshShipmentButton({
  trackingNumber,
  lastSyncedAt,
}: {
  trackingNumber: string;
  /** Pre-formatted by the server: this is a client component, and a raw Date
      here would render one timezone on the server and another in the browser. */
  lastSyncedAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);

    const formData = new FormData();
    formData.set('trackingNumber', trackingNumber);

    const result = await refreshShipmentDetail(INITIAL, formData);
    setBusy(false);
    setError(result.error);

    // Even on a refusal: `not_found` is written to the row by the sync, so the
    // badge and the copy beside it have changed.
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          className="rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)] disabled:opacity-40"
        >
          {busy ? 'Fetching…' : 'Fetch latest'}
        </button>
        <span className="text-xs opacity-50">
          {lastSyncedAt ? `checked ${lastSyncedAt}` : 'never checked'}
        </span>
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
