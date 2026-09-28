'use client';

import { useState } from 'react';
import { InfoTip } from '@/components/tooltip';
import { Badge } from '@/components/ui';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import type { CategoryOption, RootCauseOption } from '@/lib/categorise/queries';
import {
  addCategory,
  confirmCategory,
  rejectCategory,
  removeCategory,
  setRootCause,
} from '../../category-actions';
import { SidebarField } from './ticket-fields';
import { UnlinkButton } from './unlink-button';
import { type LinkAction, useFieldAction } from './use-field-action';

/**
 * What this ticket is about, and why it happened.
 *
 * Two blocks, because they answer different questions and are filled in at
 * different moments. The categories are what the customer said, detected on
 * arrival. The cause is what somebody established by looking, and it is asked
 * for at the end — which is why the resolve control refuses without it on a
 * ticket about a failure.
 *
 * A suggestion is shown separately from an applied category rather than styled
 * differently in the same list. An agent scanning a sidebar reads the list, not
 * the badges, and a suggestion sitting in that list is a category they will
 * assume somebody chose.
 */
export function CategoriesField({
  conversation,
  options,
  rootCauses,
  canCategorise,
}: {
  conversation: ConversationDetail;
  options: CategoryOption[];
  rootCauses: RootCauseOption[];
  canCategorise: boolean;
}) {
  const applied = conversation.categories.filter(
    (category) => category.reviewState === 'auto' || category.reviewState === 'confirmed',
  );
  const suggested = conversation.categories.filter(
    (category) => category.reviewState === 'suggested',
  );
  const rejected = conversation.categories.filter(
    (category) => category.reviewState === 'rejected',
  );

  // The taxonomy has not been seeded, so the picker would be an empty dropdown
  // and every control here a dead end. Saying so beats rendering the furniture.
  const unseeded = options.length === 0 && conversation.categories.length === 0;

  return (
    <SidebarField
      label="Categories"
      hint={unseeded ? 'No taxonomy yet — run the seed to create the categories.' : undefined}
    >
      {unseeded ? null : (
        <>
          <ul className="mb-2 flex flex-col gap-1">
            {applied.map((category) => (
              <li key={category.categoryId} className="text-xs">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">
                    {category.labelEn}
                    {category.isPrimary ? (
                      <span className="ml-1 opacity-50" aria-label="primary category">
                        ★
                      </span>
                    ) : null}
                  </span>
                  {canCategorise ? (
                    <UnlinkButton
                      action={category.source === 'manual' ? removeCategory : rejectCategory}
                      fields={{
                        conversationId: conversation.id,
                        categoryId: category.categoryId,
                      }}
                      label={`Remove ${category.labelEn}`}
                    />
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className="opacity-50">{category.area}</span>
                  {category.source === 'detected' ? <Badge>auto</Badge> : null}
                  {category.source === 'manual' ? <Badge tone="brand">by hand</Badge> : null}
                </div>
              </li>
            ))}
            {applied.length === 0 ? (
              <li className="text-xs opacity-50">Nothing filed yet.</li>
            ) : null}
          </ul>

          {suggested.length > 0 ? (
            <div className="mb-2 rounded border border-dashed border-current/20 p-2">
              <p className="mb-1 flex items-center gap-1 text-xs font-medium opacity-70">
                Suggested
                <InfoTip label="suggestions">
                  Found by a keyword rule rather than read outright, so it is waiting on you.
                  Confirming one teaches us the rule was right; rejecting it stops that rule
                  suggesting the same thing again on this ticket.
                </InfoTip>
              </p>
              <ul className="flex flex-col gap-1">
                {suggested.map((category) => (
                  <li key={category.categoryId} className="text-xs">
                    <div className="flex items-start justify-between gap-1">
                      <span>{category.labelEn}</span>
                      {canCategorise ? (
                        <span className="flex shrink-0 gap-1">
                          <ReviewButton
                            action={confirmCategory}
                            conversationId={conversation.id}
                            categoryId={category.categoryId}
                            label={`Confirm ${category.labelEn}`}
                            glyph="&#10003;"
                          />
                          <ReviewButton
                            action={rejectCategory}
                            conversationId={conversation.id}
                            categoryId={category.categoryId}
                            label={`Reject ${category.labelEn}`}
                            glyph="&#215;"
                          />
                        </span>
                      ) : null}
                    </div>
                    {category.ruleKey ? (
                      <p className="opacity-50">{category.ruleKey}</p>
                    ) : (
                      <p className="opacity-50">no rule matched this message</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/*
            Shown rather than hidden. A rejected category that simply vanished
            would invite the next agent to add it back by hand, and then nobody
            would know the rules had been wrong about it.
          */}
          {rejected.length > 0 ? (
            <p className="mb-2 text-xs opacity-40">
              Rejected: {rejected.map((category) => category.labelEn).join(', ')}
            </p>
          ) : null}

          {canCategorise && options.length > 0 ? (
            <CategoryPicker
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
              disabled={!canCategorise}
            />
          ) : null}
        </>
      )}
    </SidebarField>
  );
}

/** One-click confirm or reject on a suggestion. */
function ReviewButton({
  action,
  conversationId,
  categoryId,
  label,
  glyph,
}: {
  action: LinkAction;
  conversationId: string;
  categoryId: string;
  label: string;
  glyph: string;
}) {
  const { pending: busy, run: submit } = useFieldAction(action, { refresh: 'always' });

  async function run() {
    await submit({ conversationId, categoryId });
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      onClick={() => void run()}
      className="rounded px-1 text-xs opacity-60 hover:opacity-100"
      dangerouslySetInnerHTML={{ __html: glyph }}
    />
  );
}

/**
 * Adding a category by hand.
 *
 * A select rather than the free-text input the shipment field uses, because the
 * taxonomy is a closed list: a typo cannot create a category the way a typo can
 * create a shipment stub. Grouped by area, so a list of fifty is read as twelve.
 */
function CategoryPicker({
  conversationId,
  options,
  requesterKind,
}: {
  conversationId: string;
  options: CategoryOption[];
  requesterKind: ConversationDetail['requesterKind'];
}) {
  const { pending: busy, error, run } = useFieldAction(addCategory);

  /*
   * The requester's own half of the taxonomy first, everything else after it —
   * **ordered, never filtered**, and the distinction is the whole design.
   *
   * Fifty-five entries in one flat list is a list where people pick the first
   * plausible row, so putting a recipient's eleven delivery categories above a
   * merchant's payout questions is worth doing. Hiding the rest is not:
   * `requester_kind` comes off role flags that are maintained additively and
   * can be absent or stale, so a wrong one would leave an agent unable to reach
   * `billing.payout` on a merchant's ticket with no way to see why. A control
   * an agent cannot work around has to be right every time; this one cannot be.
   *
   * `any` categories — a damaged parcel is the same complaint at either end —
   * sort with the matching half rather than into the remainder.
   */
  const matches = (option: CategoryOption) =>
    requesterKind !== null && (option.audience === requesterKind || option.audience === 'any');

  const groups: { label: string; options: CategoryOption[] }[] = [];
  const byArea = (source: CategoryOption[], suffix: string) => {
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

  async function add(categoryId: string) {
    if (!categoryId) return;
    await run({ conversationId, categoryId });
  }

  return (
    <div className="mb-2">
      <select
        className="app-input w-full text-xs"
        disabled={busy}
        defaultValue=""
        aria-label="Add a category"
        onChange={(event) => {
          void add(event.target.value);
          event.target.value = '';
        }}
      >
        <option value="">Add a category…</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.labelEn}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
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
   * changed and stays there until the action and the refresh both land. On a
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
    <div className="mt-3 border-t border-current/10 pt-2">
      <p className="mb-1 flex items-center gap-1 text-xs font-medium opacity-70">
        Root cause
        <InfoTip label="the root cause">
          What actually went wrong, as opposed to what the customer asked about. Recorded by you
          rather than detected, because the customer does not know it — and it is the one field the
          reports on what to go and fix are built from. Required before resolving or closing a
          ticket about a delivery, a parcel&apos;s condition, a pickup, a return or a payment.
        </InfoTip>
      </p>
      <select
        className="app-input w-full text-xs"
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
      </select>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
