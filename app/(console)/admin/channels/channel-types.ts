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
 * `portal` and `api` rows are the product's, so they are not here, and neither
 * is a type a forged form names. The comment rows need no credentials — they
 * ride the Page and Instagram tokens — and exist to give public comments a
 * default group of their own.
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
] as const satisfies readonly { value: ConversationChannel; label: string }[];

export type ChannelType = (typeof CHANNEL_TYPES)[number]['value'];

export function isChannelType(type: string): type is ChannelType {
  return CHANNEL_TYPES.some((choice) => choice.value === type);
}

export function channelTypeLabel(type: ChannelType): string {
  return CHANNEL_TYPES.find((choice) => choice.value === type)!.label;
}
