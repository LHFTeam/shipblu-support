'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Tooltip } from '@/components/tooltip';
import { Badge } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { describeRequesterRole } from '@/lib/shipments/roles';
import { humaniseStatus, returnStepLabel, stageDisplay } from '@/lib/shipments/status';
import {
  linkShipment,
  linkShippingAccount,
  refreshShipment,
  unlinkShipment,
  unlinkShippingAccount,
} from '../../shipment-actions';
import { SidebarField } from './ticket-fields';
import { UnlinkButton } from './unlink-button';
import { type LinkAction, useFieldAction } from './use-field-action';

/**
 * The parcels a ticket is about.
 *
 * An unsynced shipment says so rather than showing a row of blanks: it was
 * created from a number somebody wrote down and nothing has confirmed it exists,
 * which is a different thing from a shipment with no shipper.
 *
 * The add control is a plain input saved on Enter, matching `TagField` in
 * `ticket-fields.tsx`.
 * This codebase has no modals, and a dialog that scrolls inside a scrolling page
 * would be the first one.
 */
export function ShipmentsField({ conversation }: { conversation: ConversationDetail }) {
  return (
    <SidebarField label="Shipments">
      <ul className="mb-2 flex flex-col gap-2">
        {conversation.shipments.map((shipment) => (
          <li key={shipment.shipmentId} className="text-xs">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/contacts/shipments/${encodeURIComponent(shipment.trackingNumber)}`}
                className="font-medium break-all hover:underline"
              >
                {shipment.trackingNumber}
              </Link>
              <UnlinkButton
                action={unlinkShipment}
                fields={{
                  conversationId: conversation.id,
                  shipmentId: shipment.shipmentId,
                  trackingNumber: shipment.trackingNumber,
                }}
                label={`Unlink ${shipment.trackingNumber}`}
              />
            </div>

            {/*
              A returning parcel says so instead of showing its status, because
              the platform's status is `delivery_attempted` for the whole of a
              return — an agent reading it would tell a customer their parcel is
              still coming (PROJECT-STATE §6.40). The return's own step is the
              honest answer, and it is the one the customer is ringing about.
            */}
            <p className="mt-0.5 opacity-60">
              {shipment.returnStep !== null
                ? returnStepLabel('en', shipment.returnStep)
                : shipment.syncState === 'synced'
                  ? shipment.statusLabel
                    ? humaniseStatus(shipment.statusLabel)
                    : 'No status yet'
                  : shipment.syncState === 'not_found'
                    ? 'Not a shipment on the platform'
                    : 'Not synced yet'}
              {shipment.syncState === 'synced' && shipment.statusAt ? (
                <>
                  {' · '}
                  <Tooltip content={formatDateTime(shipment.statusAt)}>
                    {formatRelative(shipment.statusAt)}
                  </Tooltip>
                </>
              ) : null}
            </p>

            {/*
              The date the customer is actually asking about, and only while it
              is still a prediction: never under a returning parcel, which is not
              being delivered to anybody, and never under a delivered one.
            */}
            {shipment.returnStep === null &&
            shipment.currentEstimatedDate &&
            !stageDisplay(shipment.statusLabel).terminal ? (
              <p className="opacity-60">Due {shipment.currentEstimatedDate}</p>
            ) : null}

            <p className="opacity-60">{describeRequesterRole(shipment.requesterRole)}</p>

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {shipment.returnStep !== null ? <Badge tone="warning">returning</Badge> : null}
              {shipment.sbid ? (
                <Link href={`/contacts/accounts/${encodeURIComponent(shipment.sbid)}`}>
                  <Badge>SBID {shipment.sbid}</Badge>
                </Link>
              ) : null}
              {shipment.linkSource === 'detected' ? <Badge>auto</Badge> : null}
            </div>

            <RefreshShipmentButton
              conversationId={conversation.id}
              shipmentId={shipment.shipmentId}
              trackingNumber={shipment.trackingNumber}
              lastSyncedAt={shipment.lastSyncedAt}
            />
          </li>
        ))}
        {conversation.shipments.length === 0 ? (
          <li className="text-xs opacity-50">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShipment}
        conversationId={conversation.id}
        name="trackingNumber"
        placeholder="Add a tracking number"
      />
    </SidebarField>
  );
}

/**
 * SBIDs this ticket names.
 *
 * A mention, not a membership. Somebody quoting an account number in a message
 * says the number came up here; saying they belong to that account is a claim
 * about their identity and is made on the customer's own page instead.
 */
export function ShippingAccountsField({ conversation }: { conversation: ConversationDetail }) {
  return (
    <SidebarField label="Shipping accounts">
      <ul className="mb-2 flex flex-col gap-1.5">
        {conversation.shippingAccounts.map((account) => (
          <li key={account.shippingAccountId} className="flex items-center justify-between gap-2">
            <Link
              href={`/contacts/accounts/${encodeURIComponent(account.sbid)}`}
              className="text-xs font-medium hover:underline"
            >
              {account.name ?? `SBID ${account.sbid}`}
            </Link>
            <div className="flex items-center gap-1">
              {account.linkSource === 'detected' ? <Badge>auto</Badge> : null}
              <UnlinkButton
                action={unlinkShippingAccount}
                fields={{
                  conversationId: conversation.id,
                  shippingAccountId: account.shippingAccountId,
                  sbid: account.sbid,
                }}
                label={`Unlink ${account.sbid}`}
              />
            </div>
          </li>
        ))}
        {conversation.shippingAccounts.length === 0 ? (
          <li className="text-xs opacity-50">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShippingAccount}
        conversationId={conversation.id}
        name="sbid"
        placeholder="Add an SBID"
      />
    </SidebarField>
  );
}

/**
 * "Fetch the latest" for one parcel.
 *
 * The agent presses it and waits — `refreshShipment` calls the shipping platform
 * in the action rather than queueing, because the entire output of the button is
 * the platform's answer and a customer is on the line for it. AGENTS.md records
 * that exception and its one condition, which is that the provider call stays in
 * `syncShipment`, shared with the job.
 *
 * It says when the parcel was last read rather than only offering to read it
 * again. "Delivered" with no date beside it invites an agent to repeat it to a
 * customer as though it were current; "checked 4d ago" is the fact that makes
 * pressing the button an informed decision instead of a nervous habit.
 *
 * Errors render in place. A platform that cannot be reached is the single most
 * likely outcome of pressing this, and a button that silently does nothing is
 * how an agent ends up telling a customer a four-day-old status is live.
 */
function RefreshShipmentButton({
  conversationId,
  shipmentId,
  trackingNumber,
  lastSyncedAt,
}: {
  conversationId: string;
  shipmentId: string;
  trackingNumber: string;
  lastSyncedAt: Date | null;
}) {
  // A refusal re-reads the page: a shipment that is gone, or was unlinked by
  // somebody else, has changed under the agent. (`not_found` revalidates
  // itself, since the sync writes it to the row.)
  const {
    pending: busy,
    error,
    run: submit,
  } = useFieldAction(refreshShipment, { rereadOnRefusal: true });

  async function run() {
    await submit({ conversationId, shipmentId });
  }

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          aria-label={`Fetch the latest status for ${trackingNumber}`}
          className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs hover:bg-[var(--muted)] disabled:opacity-40"
        >
          {busy ? 'Fetching…' : 'Fetch latest'}
        </button>

        <span className="text-xs opacity-50">
          {lastSyncedAt ? (
            <Tooltip content={formatDateTime(lastSyncedAt)}>
              checked {formatRelative(lastSyncedAt)} ago
            </Tooltip>
          ) : (
            'never checked'
          )}
        </span>
      </div>

      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}

function LinkInput({
  action,
  conversationId,
  name,
  placeholder,
}: {
  action: LinkAction;
  conversationId: string;
  name: string;
  placeholder: string;
}) {
  const [value, setValue] = useState('');
  const { pending: saving, error, run } = useFieldAction(action, { clearError: false });

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) return;

    const result = await run({ conversationId, [name]: trimmed });
    if (!result.error) setValue('');
  }

  return (
    <div>
      <input
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
        onBlur={() => void save()}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs outline-none focus:border-brand-500"
      />
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
