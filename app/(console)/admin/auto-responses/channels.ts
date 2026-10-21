/**
 * The channels an out-of-hours rule may name, and what the form calls each one.
 *
 * One list, read by the form for its options and by `saveAutoResponse` for
 * what it accepts, outside both files because a `'use server'` module may
 * export nothing but actions. An option the action rejects is a form that
 * fails on save for no reason the admin can see.
 *
 * `whatsapp_bot` is deliberately absent. Nothing is ever sent on it — the bot
 * owns those conversations — so offering it would be offering a setting that
 * cannot do anything.
 *
 * The comment channels are here because naming one is the only way a public
 * comment is acknowledged at all: a rule with no channel skips them
 * (`pickRule`), since the reply is posted under the comment for anybody reading
 * the post to see. They arrived with the stage that writes them (Stage 1.2 of
 * `plans/ticket-category-routing.md`): accepted in 1.1, a rule naming one would
 * have been the first row to carry the value, and rolling 1.1 back would have
 * put it in front of an editor that lists it as company-wide and saves it back
 * as every channel.
 */
export const AUTO_RESPONSE_CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'webchat', label: 'Web chat' },
  { value: 'facebook', label: 'Facebook messages' },
  { value: 'facebook_comment', label: 'Facebook comments' },
  { value: 'instagram', label: 'Instagram messages' },
  { value: 'instagram_comment', label: 'Instagram comments' },
  { value: 'portal', label: 'Customer portal' },
] as const;

export type AutoResponseChannel = (typeof AUTO_RESPONSE_CHANNELS)[number]['value'];

export function isAutoResponseChannel(value: string): value is AutoResponseChannel {
  return AUTO_RESPONSE_CHANNELS.some((channel) => channel.value === value);
}
