'use client';

import { useState } from 'react';
import Link from 'next/link';
import { RelativeTime } from '@/components/relative-time';
import { Button, ErrorText, Input } from '@/components/ui';
import { ago } from '@/lib/format';
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

    if (!result.error) setValue('');
  }

  return (
    <div>
      {current ? (
        <div className="mb-2 text-sm">
          <Link href={`/contacts/${current.id}`} className="font-medium hover:underline">
            {current.name ?? 'Unnamed'}
          </Link>
          {current.handle ? (
            <p className="text-xs text-(--color-text-secondary)">{current.handle}</p>
          ) : null}
        </div>
      ) : (
        <p className="mb-2 text-xs text-(--color-text-tertiary)">Not named.</p>
      )}

      {editable ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Input
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Contact id"
              aria-label={`Set the ${party}`}
              className="min-w-0 flex-1"
            />
            <Button
              variant="secondary"
              disabled={busy || !value.trim()}
              onClick={() => void save(value.trim())}
              className="shrink-0"
            >
              Set
            </Button>
          </div>

          {current ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void save('')}
              className="self-start"
            >
              Clear
            </Button>
          ) : null}

          {error ? <ErrorText inline>{error}</ErrorText> : null}
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
  /** The instant, not a phrase made from it on the server: a phrase is frozen at
      render, where the ticket sidebar's twin keeps counting, and on a page left
      open the two would disagree about the same parcel. */
  lastSyncedAt: Date | string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);

    const formData = new FormData();
    formData.set('trackingNumber', trackingNumber);

    // A refusal after the sync brings the page back too: the action revalidates
    // as soon as the sync has run, because `not_found` is written to the row and
    // the badge beside this button has changed. The two before it — no
    // permission, no tracking number — change nothing.
    const result = await refreshShipmentDetail(INITIAL, formData);
    setBusy(false);
    setError(result.error);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          loading={busy}
          onClick={() => void run()}
        >
          {busy ? 'Fetching…' : 'Fetch latest'}
        </Button>
        <span className="text-xs text-(--color-text-tertiary)">
          {lastSyncedAt ? (
            <RelativeTime at={lastSyncedAt}>
              {(relative) => `checked ${ago(relative)}`}
            </RelativeTime>
          ) : (
            'never checked'
          )}
        </span>
      </div>
      {error ? <ErrorText inline>{error}</ErrorText> : null}
    </div>
  );
}
