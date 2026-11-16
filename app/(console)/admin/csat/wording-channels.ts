import { channelLabel } from '@/lib/format';
import { CHANNEL_LABELS } from '@/lib/tickets/channel-labels';

/**
 * The channels a survey goes out on, named as the rest of the console names
 * them (`CHANNEL_LABELS`). Every one is in the list the action validates
 * against — an option here the action rejects is a form that fails on save
 * for no reason the admin can see.
 *
 * The myBlu app is accepted there and not offered here: no survey reaches the
 * app before its stage (`plans/myblu-ticket-api.md`, stage 8;
 * `channelSwitch('api')` answers null), so a new wording scoped to it would be
 * a rule nothing ever reads. It joins this list with that stage.
 */
const OFFERED = ['email', 'webchat', 'facebook', 'instagram', 'portal'] as const;

export type ChannelOption = { value: string; label: string };

/**
 * The Channel field's options for one rule: the channels offered, and the
 * rule's own stored channel when it is not one of them.
 *
 * Without the second, a rule stored with a channel the action still accepts
 * but the form no longer offers — `api`, until stage 8 — opened with no option
 * matching its `defaultValue`, so the browser selected the first, "Every
 * channel", and a save that changed only the wording rescoped the rule to
 * every channel, or was refused on the scope's unique key where such a rule
 * existed. Kept, the field shows what is stored, and a save leaves it there
 * unless the admin picks another.
 */
export function wordingChannelOptions(stored: string | null | undefined): ChannelOption[] {
  const options: ChannelOption[] = OFFERED.map((value) => ({
    value,
    label: CHANNEL_LABELS[value],
  }));
  if (stored && !options.some((option) => option.value === stored)) {
    options.push({ value: stored, label: channelLabel(stored) });
  }
  return options;
}

/** A rule's scope as the list names it: its channel, or every channel. */
export function ruleChannelLabel(value: string | null): string {
  return value ? channelLabel(value) : 'Every channel';
}
