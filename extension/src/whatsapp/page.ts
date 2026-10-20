import type { ChatState } from '../messages';
import { messageKey, ownNumber } from './keys';

/**
 * What WhatsApp Web is showing, read off the page.
 *
 * **Provisional until stage 0 is measured** (`plans/whatsapp-web-extension.md`).
 * The first reading, taken on a personal account with no chat open, found no
 * `[data-id]` anywhere and no `#main`, so it could not say whether an open
 * chat still marks its rows that way; it did find every message key in
 * WhatsApp Web's own IndexedDB (`model-storage`, store `message`), in exactly
 * the shape `messageKey` reads. Everything WhatsApp-specific is in this file so
 * that the measurement changes this file and nothing else.
 *
 * Read-only. Nothing here writes to the page, its storage or its databases:
 * the extension is a reader beside WhatsApp Web, not a client of it.
 */

/** How many of the newest keys to send — enough to survive a few that the server never stored. */
const KEYS_SENT = 30;

export function readChatState(): ChatState {
  return { me: ownNumber(readOwnId()), keys: openChatKeys() };
}

function readOwnId(): string | null {
  try {
    return window.localStorage.getItem('last-wid-md');
  } catch {
    return null;
  }
}

/**
 * The open chat's message keys, newest last, or null when no chat is open.
 *
 * `#main` is the conversation pane; rows carry their key as `data-id`. Both
 * are WhatsApp Web's markup rather than an interface it offers, which is why a
 * change to them is a change to this one function.
 */
function openChatKeys(): string[] | null {
  const pane = document.querySelector('#main');
  if (!pane) return null;

  const keys: string[] = [];
  const seen = new Set<string>();
  for (const element of pane.querySelectorAll('[data-id]')) {
    const key = messageKey(element.getAttribute('data-id') ?? '');
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.slice(-KEYS_SENT);
}
