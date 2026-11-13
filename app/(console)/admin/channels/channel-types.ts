import { CHANNEL_LABELS } from '@/lib/tickets/channel-labels';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';

/**
 * The types an admin may create or save, and what the form calls each one.
 *
 * One list, read by the form for its options and by `saveChannel` for what it
 * accepts, and kept out of both files for the reason `settings-shared.ts` is:
 * a `'use server'` module may export nothing but actions. Two copies kept in
 * step by a comment were a form offering a type the action refuses, or an
 * editor hiding a row the action would save, the day one of them moved.
 *
 * `api` is an admin's, since stage 2 of `plans/myblu-ticket-api.md`; until
 * then this said `api` rows were the product's. Its row is where the myBlu
 * app's new tickets start — which group, and with it the hours the app is
 * told, and whether they route by category — and that is the support lead's
 * call, which no seed or migration can know. Switching it off is how new
 * tickets from the app are stopped (`setApiChannelActive`), so a person has
 * to be able to make it, edit it and switch it from the console. Its config
 * is empty: the app is not addressed by anything a row could hold.
 *
 * `portal` is still not here, and neither is a type a forged form names. The
 * comment rows need no credentials — they ride the Page and Instagram tokens —
 * and exist to give public comments a default group of their own.
 */
export const CHANNEL_TYPES = [
  { value: 'email', label: 'Email' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'webchat', label: 'Web chat' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'facebook_comment', label: 'Facebook comments' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'instagram_comment', label: 'Instagram comments' },
  { value: 'whatsapp_bot', label: 'WhatsApp — customer bot' },
  // The shared name rather than a copy of it: "myBlu app" is a decision about
  // who the channel's one caller is (`channel-labels.ts`), and the badge beside
  // each row reads that, so a rename there must not leave this option behind.
  { value: 'api', label: CHANNEL_LABELS.api },
] as const satisfies readonly { value: ConversationChannel; label: string }[];

export type ChannelType = (typeof CHANNEL_TYPES)[number]['value'];

export function isChannelType(type: string): type is ChannelType {
  return CHANNEL_TYPES.some((choice) => choice.value === type);
}

export function channelTypeLabel(type: ChannelType): string {
  return CHANNEL_TYPES.find((choice) => choice.value === type)!.label;
}
