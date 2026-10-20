import { isChatState, type ChatState, type PanelRequest } from './messages';
import { readChatState } from './whatsapp/page';

/**
 * Runs inside web.whatsapp.com. Reads which chat is open and tells the side
 * panel, and does nothing else: it holds no token and calls no server, so
 * nothing the page can reach in this script is worth reaching.
 *
 * WhatsApp Web re-renders constantly — typing indicators, presence, receipts —
 * so changes are read at most every half second and announced only when what
 * the panel cares about actually changed.
 */

const SETTLE_MS = 500;

let announced = '';
let timer: ReturnType<typeof setTimeout> | null = null;

function announce(state: ChatState) {
  const serialised = JSON.stringify(state);
  if (serialised === announced) return;
  announced = serialised;
  // Rejects when no panel is open to hear it, which is the usual case.
  chrome.runtime.sendMessage({ type: 'chat', state }).catch(() => {});
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const state = readChatState();
    if (isChatState(state)) announce(state);
  }, SETTLE_MS);
}

new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
schedule();

// A panel opening asks for the current state rather than waiting for the next
// change, which on a quiet chat may be a long time coming.
chrome.runtime.onMessage.addListener((message: PanelRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'get-chat') return undefined;
  sendResponse(readChatState());
  return undefined;
});
