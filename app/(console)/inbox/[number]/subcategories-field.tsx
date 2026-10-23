'use client';

import { useState } from 'react';
import { DetailsSection } from '@/components/details-section';
import { CheckIcon, XIcon } from '@/components/icons';
import { InfoTip } from '@/components/tooltip';
import { Badge, Select } from '@/components/ui';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import type { SubcategoryOption, RootCauseOption } from '@/lib/subcategorise/queries';
import {
  addSubcategory,
  confirmSubcategory,
  rejectSubcategory,
  removeSubcategory,
  setRootCause,
} from '../../subcategory-actions';
import { FieldError } from './ticket-fields';
import { UnlinkButton } from './unlink-button';
import { type LinkAction, useFieldAction } from './use-field-action';

/**
 * What this ticket is about, and why it happened.
 *
 * Two blocks, because they answer different questions and are filled in at
 * different moments. The subcategories are what the customer said, detected on
 * arrival. The cause is what somebody established by looking, and it is asked
 * for at the end — which is why the resolve control refuses without it on a
 * ticket about a failure.
 *
 * A suggestion is shown separately from an applied subcategory rather than
 * styled differently in the same list. An agent scanning a sidebar reads the
 * list, not the badges, and a suggestion sitting in that list is a subcategory
 * they will assume somebody chose.
 */
export function SubcategoriesField({
  conversation,
  options,
  rootCauses,
  canSubcategorise,
}: {
  conversation: ConversationDetail;
  options: SubcategoryOption[];
  rootCauses: RootCauseOption[];
  canSubcategorise: boolean;
}) {
  const applied = conversation.subcategories.filter(
    (subcategory) => subcategory.reviewState === 'auto' || subcategory.reviewState === 'confirmed',
  );
  const suggested = conversation.subcategories.filter(
    (subcategory) => subcategory.reviewState === 'suggested',
  );
  const rejected = conversation.subcategories.filter(
    (subcategory) => subcategory.reviewState === 'rejected',
  );

  // The taxonomy has not been seeded, so the picker would be an empty dropdown
  // and every control here a dead end. Saying so beats rendering the furniture.
  const unseeded = options.length === 0 && conversation.subcategories.length === 0;

  return (
    <DetailsSection collapsible={false} title="Subcategories">
      {unseeded ? (
        <p className="text-xs text-(--color-text-secondary)">
          No taxonomy yet — run the seed to create the subcategories.
        </p>
      ) : (
        <>
          <ul className="mb-3 flex flex-col gap-2">
            {applied.map((subcategory) => (
              <li key={subcategory.subcategoryId} className="text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium">
                    {subcategory.labelEn}
                    {/* Worded, not a star: a glyph nobody explained is a guess. */}
                    {subcategory.isPrimary ? <Badge>Primary</Badge> : null}
                  </span>
                  {canSubcategorise ? (
                    <UnlinkButton
                      action={
                        subcategory.source === 'manual' ? removeSubcategory : rejectSubcategory
                      }
                      fields={{
                        conversationId: conversation.id,
                        subcategoryId: subcategory.subcategoryId,
                      }}
                      label={`Remove ${subcategory.labelEn}`}
                    />
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-(--color-text-secondary)">
                  <span>{subcategory.area}</span>
                  {/* Dashed, because a rule filed it and no person did. */}
                  {subcategory.source === 'detected' ? <Badge tone="automated">Auto</Badge> : null}
                  {subcategory.source === 'manual' ? <Badge tone="info">By hand</Badge> : null}
                </div>
              </li>
            ))}
            {applied.length === 0 ? (
              <li className="text-sm text-(--color-text-tertiary)">Nothing filed yet.</li>
            ) : null}
          </ul>

          {suggested.length > 0 ? (
            // Dashed for the same reason as the Auto badge: nobody has looked
            // at these yet, a keyword rule wrote them.
            <div className="mb-3 rounded-lg border border-dashed border-(--color-border-strong) p-2.5">
              <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-(--color-text-secondary)">
                Suggested
                <InfoTip label="suggestions">
                  Found by a keyword rule rather than read outright, so it is waiting on you.
                  Confirming one teaches us the rule was right; rejecting it stops that rule
                  suggesting the same thing again on this ticket.
                </InfoTip>
              </p>
              <ul className="flex flex-col gap-1">
                {suggested.map((subcategory) => (
                  <li key={subcategory.subcategoryId} className="text-sm">
                    <div className="flex items-start justify-between gap-1">
                      <span>{subcategory.labelEn}</span>
                      {canSubcategorise ? (
                        <span className="flex shrink-0 gap-0.5">
                          <ReviewButton
                            action={confirmSubcategory}
                            conversationId={conversation.id}
                            subcategoryId={subcategory.subcategoryId}
                            label={`Confirm ${subcategory.labelEn}`}
                            kind="confirm"
                          />
                          <ReviewButton
                            action={rejectSubcategory}
                            conversationId={conversation.id}
                            subcategoryId={subcategory.subcategoryId}
                            label={`Reject ${subcategory.labelEn}`}
                            kind="reject"
                          />
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs break-all text-(--color-text-tertiary)">
                      {subcategory.ruleKey ?? 'no rule matched this message'}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            Shown rather than hidden. A rejected subcategory that simply
            vanished would invite the next agent to add it back by hand, and
            then nobody would know the rules had been wrong about it.
          */}
          {rejected.length > 0 ? (
            <p className="mb-3 text-xs text-(--color-text-tertiary)">
              Rejected: {rejected.map((subcategory) => subcategory.labelEn).join(', ')}
            </p>
          ) : null}

          {canSubcategorise && options.length > 0 ? (
            <SubcategoryPicker
              conversationId={conversation.id}
              options={options}
              requesterKind={conversation.requesterKind}
            />
          ) : null}

          {rootCauses.length > 0 ? (
            <RootCausePicker
              conversationId={conversation.id}
              rootCauses={rootCauses}
              value={conversation.rootCauseId}
              disabled={!canSubcategorise}
            />
          ) : null}
        </>
      )}
    </DetailsSection>
  );
}

/** One-click confirm or reject on a suggestion. */
function ReviewButton({
  action,
  conversationId,
  subcategoryId,
  label,
  kind,
}: {
  action: LinkAction;
  conversationId: string;
  subcategoryId: string;
  label: string;
  kind: 'confirm' | 'reject';
}) {
  const { pending: busy, run: submit } = useFieldAction(action, { rereadOnRefusal: true });

  async function run() {
    await submit({ conversationId, subcategoryId });
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      onClick={() => void run()}
      className="rounded-md p-1 text-(--color-text-secondary) transition-colors hover:bg-(--color-background-hover) hover:text-(--color-text-primary) disabled:opacity-50"
    >
      {kind === 'confirm' ? <CheckIcon size={14} /> : <XIcon size={14} />}
    </button>
  );
}

/**
 * Adding a subcategory by hand.
 *
 * A select rather than the free-text input the shipment field uses, because the
 * taxonomy is a closed list: a typo cannot create a subcategory the way a typo
 * can create a shipment stub. Grouped by area, so a list of fifty is read as
 * twelve.
 */
function SubcategoryPicker({
  conversationId,
  options,
  requesterKind,
}: {
  conversationId: string;
  options: SubcategoryOption[];
  requesterKind: ConversationDetail['requesterKind'];
}) {
  const { pending: busy, error, run } = useFieldAction(addSubcategory);

  /*
   * The requester's own half of the taxonomy first, everything else after it —
   * **ordered, never filtered**, and the distinction is the whole design.
   *
   * Fifty-five entries in one flat list is a list where people pick the first
   * plausible row, so putting a recipient's eleven delivery subcategories above
   * a merchant's payout questions is worth doing. Hiding the rest is not:
   * `requester_kind` comes off role flags that are maintained additively and
   * can be absent or stale, so a wrong one would leave an agent unable to reach
   * `billing.payout` on a merchant's ticket with no way to see why. A control
   * an agent cannot work around has to be right every time; this one cannot be.
   *
   * `any` subcategories — a damaged parcel is the same complaint at either
   * end — sort with the matching half rather than into the remainder.
   */
  const matches = (option: SubcategoryOption) =>
    requesterKind !== null && (option.audience === requesterKind || option.audience === 'any');

  const groups: { label: string; options: SubcategoryOption[] }[] = [];
  const byArea = (source: SubcategoryOption[], suffix: string) => {
    for (const area of [...new Set(source.map((option) => option.area))]) {
      groups.push({
        label: `${area}${suffix}`,
        options: source.filter((option) => option.area === area),
      });
    }
  };

  const relevant = options.filter(matches);
  if (relevant.length === 0) {
    // Nothing established about who is asking, so there is no "other" half to
    // put anything under — labelling every group that way would say the
    // opposite of what is known.
    byArea(options, '');
  } else {
    byArea(relevant, '');
    byArea(
      options.filter((option) => !matches(option)),
      ' — other',
    );
  }

  async function add(subcategoryId: string) {
    if (!subcategoryId) return;
    await run({ conversationId, subcategoryId });
  }

  return (
    <div>
      <Select
        disabled={busy}
        defaultValue=""
        aria-label="Add a subcategory"
        onChange={(event) => {
          void add(event.target.value);
          event.target.value = '';
        }}
      >
        <option value="">Add a subcategory…</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.labelEn}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <FieldError>{error}</FieldError>
    </div>
  );
}

/**
 * Why the ticket happened.
 *
 * Grouped by who owns the fix, because that is the grouping an agent reasons in
 * — "was this us, the courier, or the merchant" — and because it makes the
 * accountability report's shape visible at the point the data is entered.
 */
function RootCausePicker({
  conversationId,
  rootCauses,
  value,
  disabled,
}: {
  conversationId: string;
  rootCauses: RootCauseOption[];
  value: string | null;
  disabled: boolean;
}) {
  const { pending: busy, error, run } = useFieldAction(setRootCause);

  /*
   * Held locally as well as in the prop, because a `<select>` whose value comes
   * only from the server snaps back to the old option the instant it is
   * changed and stays there until the action's answer, and the page it brings
   * back, land. On a
   * `force-dynamic` page that is long enough to read as "it did not take", and
   * an agent's second attempt writes the same value twice.
   *
   * Reset to the prop whenever the server disagrees — which is how a rejected
   * write, or another agent's choice arriving on a refresh, wins.
   */
  const [chosen, setChosen] = useState<string>(value ?? '');
  const [seen, setSeen] = useState<string | null>(value);
  if (seen !== value) {
    setSeen(value);
    setChosen(value ?? '');
  }

  const owners = [...new Set(rootCauses.map((cause) => cause.owner))];

  async function save(rootCauseId: string) {
    setChosen(rootCauseId);
    const result = await run({ conversationId, rootCauseId });
    if (result.error) setChosen(value ?? '');
  }

  return (
    <div className="mt-4 border-t border-(--color-border-subtle) pt-3">
      <p className="mb-1 flex items-center gap-1 text-xs font-medium text-(--color-text-secondary)">
        Root cause
        <InfoTip label="the root cause">
          What actually went wrong, as opposed to what the customer asked about. Recorded by you
          rather than detected, because the customer does not know it — and it is the one field the
          reports on what to go and fix are built from. Required before resolving or closing a
          ticket about a delivery, a parcel&apos;s condition, a pickup, a return or a payment.
        </InfoTip>
      </p>
      <Select
        disabled={disabled || busy}
        value={chosen}
        aria-label="Root cause"
        onChange={(event) => void save(event.target.value)}
      >
        <option value="">Not established yet</option>
        {owners.map((owner) => (
          <optgroup key={owner} label={owner}>
            {rootCauses
              .filter((cause) => cause.owner === owner)
              .map((cause) => (
                <option key={cause.id} value={cause.id}>
                  {cause.labelEn}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
      <FieldError>{error}</FieldError>
    </div>
  );
}
