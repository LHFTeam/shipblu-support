'use client';

import { useState } from 'react';
import Link from 'next/link';
import { DetailsSection, Property, PropertyList } from '@/components/details-section';
import { PlusIcon, ReturnIcon } from '@/components/icons';
import { StatusBadge, Stepper } from '@/components/shipment-status';
import { Tooltip } from '@/components/tooltip';
import { Badge, Button, Input } from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { describeRequesterRole } from '@/lib/shipments/roles';
import {
  linkShipment,
  linkShippingAccount,
  refreshShipment,
  unlinkShipment,
  unlinkShippingAccount,
} from '../../shipment-actions';
import { shipmentCard } from '@/lib/shipments/card';
import { FieldError } from './ticket-fields';
import { UnlinkButton } from './unlink-button';
import { type LinkAction, useFieldAction } from './use-field-action';

/**
 * The parcels a ticket is about, one card each.
 *
 * An unsynced shipment says so rather than showing a row of blanks: it was
 * created from a number somebody wrote down and nothing has confirmed it exists,
 * which is a different thing from a shipment with no shipper.
 *
 * What the card says about the parcel — its words, its tone, which bar it walks
 * — is decided by `shipmentCard`, which is where the rule that a return outranks
 * the status label lives (§6.40). Only what the agent can act on is here: no
 * merchant, COD or hub row, because those live in the platform payload and that
 * is read only through `agentTracking()` on the shipment's own page.
 *
 * The add control is a plain input saved on Enter, matching `TagField` in
 * `ticket-fields.tsx`.
 * This codebase has no modals, and a dialog that scrolls inside a scrolling page
 * would be the first one.
 */
export function ShipmentsField({ conversation }: { conversation: ConversationDetail }) {
  return (
    <DetailsSection collapsible={false} title={`Shipments · ${conversation.shipments.length}`}>
      <ul className="mb-3 grid gap-2">
        {conversation.shipments.map((shipment) => {
          const card = shipmentCard(shipment);

          return (
            <li
              key={shipment.shipmentId}
              className="grid gap-3 rounded-lg border border-(--color-border-subtle) bg-(--color-background-surface) p-3"
            >
              {/* Wraps rather than squeezing: "Not a shipment on the platform"
                  beside a thirteen-digit number is wider than the card. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link
                  href={`/contacts/shipments/${encodeURIComponent(shipment.trackingNumber)}`}
                  dir="ltr"
                  className="min-w-0 font-mono text-xs break-all text-(--color-text-link) hover:underline"
                >
                  {shipment.trackingNumber}
                </Link>
                <span className="ms-auto flex shrink-0 items-center gap-1">
                  <StatusBadge size="sm" label={card.label} tone={card.tone} />
                  <UnlinkButton
                    action={unlinkShipment}
                    fields={{
                      conversationId: conversation.id,
                      shipmentId: shipment.shipmentId,
                      trackingNumber: shipment.trackingNumber,
                    }}
                    label={`Unlink ${shipment.trackingNumber}`}
                  />
                </span>
              </div>

              {card.bar ? (
                <Stepper
                  size="sm"
                  tone={card.bar.tone}
                  labels={card.bar.labels}
                  current={card.bar.step}
                  doneLabel="done"
                />
              ) : null}

              <PropertyList>
                <Property
                  label="Updated"
                  value={
                    shipment.syncState === 'synced' && shipment.statusAt ? (
                      <Tooltip content={formatDateTime(shipment.statusAt)}>
                        {formatRelative(shipment.statusAt)}
                      </Tooltip>
                    ) : null
                  }
                />
                <Property label="Due" value={card.due} ltr />
                <Property
                  label="Account"
                  ltr
                  value={
                    shipment.sbid ? (
                      <Link
                        href={`/contacts/accounts/${encodeURIComponent(shipment.sbid)}`}
                        className="text-(--color-text-link) hover:underline"
                      >
                        SBID {shipment.sbid}
                      </Link>
                    ) : null
                  }
                />
              </PropertyList>

              <div className="flex flex-wrap items-center gap-1.5 text-xs text-(--color-text-secondary)">
                <span className="me-auto">{describeRequesterRole(shipment.requesterRole)}</span>
                {shipment.returnStep !== null ? (
                  <Badge icon={<ReturnIcon size={12} className="shrink-0" />}>Returning</Badge>
                ) : null}
                {/* Dashed, because a rule linked it and no person did. */}
                {shipment.linkSource === 'detected' ? <Badge tone="automated">Auto</Badge> : null}
              </div>

              <RefreshShipmentButton
                conversationId={conversation.id}
                shipmentId={shipment.shipmentId}
                trackingNumber={shipment.trackingNumber}
                lastSyncedAt={shipment.lastSyncedAt}
              />
            </li>
          );
        })}
        {conversation.shipments.length === 0 ? (
          <li className="text-sm text-(--color-text-tertiary)">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShipment}
        conversationId={conversation.id}
        name="trackingNumber"
        placeholder="Add a tracking number"
      />
    </DetailsSection>
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
    <DetailsSection
      variant="flush"
      collapsible={false}
      title={`Shipping accounts · ${conversation.shippingAccounts.length}`}
    >
      <ul className="mb-3 flex flex-col gap-1.5">
        {conversation.shippingAccounts.map((account) => (
          <li
            key={account.shippingAccountId}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <Link
              href={`/contacts/accounts/${encodeURIComponent(account.sbid)}`}
              dir="auto"
              className="min-w-0 truncate font-medium text-(--color-text-link) hover:underline"
            >
              {account.name ?? `SBID ${account.sbid}`}
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              {account.linkSource === 'detected' ? <Badge tone="automated">Auto</Badge> : null}
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
          <li className="text-sm text-(--color-text-tertiary)">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShippingAccount}
        conversationId={conversation.id}
        name="sbid"
        placeholder="Add an SBID"
      />
    </DetailsSection>
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
  // No re-read on a refusal: the ones that mean the sidebar is out of date —
  // unlinked, gone, or `not_found` written to the row — revalidate in the
  // action, so the page comes back with them.
  const { pending: busy, error, run: submit } = useFieldAction(refreshShipment);

  async function run() {
    await submit({ conversationId, shipmentId });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          loading={busy}
          onClick={() => void run()}
          aria-label={`Fetch the latest status for ${trackingNumber}`}
        >
          {busy ? 'Fetching…' : 'Fetch latest'}
        </Button>

        <span className="text-xs text-(--color-text-tertiary)">
          {lastSyncedAt ? (
            <Tooltip content={formatDateTime(lastSyncedAt)}>
              checked {formatRelative(lastSyncedAt)} ago
            </Tooltip>
          ) : (
            'never checked'
          )}
        </span>
      </div>

      <FieldError>{error}</FieldError>
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
      {/* Its own row, not a "Link" button in the section header that opens
          one: the number is usually on the agent's clipboard already, and one
          box is one step fewer than a button and then a box. */}
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 start-2 flex items-center text-(--color-text-tertiary)">
          <PlusIcon size={15} />
        </span>
        <Input
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
          className="ps-7"
        />
      </div>
      <FieldError>{error}</FieldError>
    </div>
  );
}
