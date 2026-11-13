import type { ConversationChannel } from './channel-policy';

/**
 * Each channel's name, once, for the badge (`components/channel.tsx`) and for
 * text (`channelLabel` in `lib/format.ts`).
 *
 * The two used to keep their own names, and the text half knew only email,
 * WhatsApp and web chat: every other channel printed its enum value, so the
 * reports said `facebook` and would have said `facebook_comment`. Keyed by the
 * enum, so a channel added to it does not compile until it has a name.
 */
export const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  whatsapp_bot: 'Customer bot',
  webchat: 'Web chat',
  facebook: 'Facebook',
  facebook_comment: 'Facebook comment',
  instagram: 'Instagram',
  instagram_comment: 'Instagram comment',
  portal: 'Portal',
  // The `api` channel has one caller, the myBlu app, named in code
  // (`plans/myblu-ticket-api.md`). "API" told an agent nothing about who wrote
  // in, and could not tell a myBlu ticket from a later caller's; a second
  // caller is a decision of its own, with its own name.
  api: 'myBlu app',
};
