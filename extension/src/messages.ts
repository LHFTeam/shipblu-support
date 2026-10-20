/**
 * What the content script and the side panel say to each other.
 *
 * Only this: which WhatsApp number the page is signed in as, and the message
 * keys of the chat on screen. The content script runs inside web.whatsapp.com
 * and never holds the agent's token or calls the console — everything it knows
 * is about the page, and the panel decides what to ask the server.
 */

export type ChatState = {
  /** The number WhatsApp Web is signed in as, digits only, or null if unread. */
  me: string | null;
  /**
   * The open chat's messages as `out:<id>` / `in:<id>` — the shape `wamidKey`
   * gives a stored wamid — newest last. Null when no chat is open.
   */
  keys: string[] | null;
};

export type ContentMessage = { type: 'chat'; state: ChatState };
export type PanelRequest = { type: 'get-chat' };

/**
 * Whether a runtime message is a chat update. The panel hears every message
 * the extension's scripts send, so it checks the shape before reading it.
 */
export function isChatUpdate(message: unknown): message is ContentMessage {
  if (typeof message !== 'object' || message === null) return false;
  const { type, state } = message as { type?: unknown; state?: unknown };
  return type === 'chat' && isChatState(state);
}

export function isChatState(value: unknown): value is ChatState {
  if (typeof value !== 'object' || value === null) return false;
  const { me, keys } = value as { me?: unknown; keys?: unknown };
  return (
    (me === null || typeof me === 'string') &&
    (keys === null || (Array.isArray(keys) && keys.every((key) => typeof key === 'string')))
  );
}
