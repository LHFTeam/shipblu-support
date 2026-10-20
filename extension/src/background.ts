/**
 * The service worker: decides where the side panel may open, and nothing more.
 *
 * Only on WhatsApp Web. Everywhere else the panel would have no chat to read
 * and nothing to show, so it is disabled per tab, and the toolbar button opens
 * it only where it is enabled. The worker holds no state — Chrome stops it
 * whenever it likes — and never sees the agent's token.
 */

const WHATSAPP_WEB = 'https://web.whatsapp.com/';

function onWhatsApp(url: string | undefined): boolean {
  return url?.startsWith(WHATSAPP_WEB) ?? false;
}

async function configure(tabId: number, url: string | undefined) {
  await chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled: onWhatsApp(url) });
}

// Off by default, on for the tabs below. Set on every start rather than only on
// install, because both survive a restart and a stale one costs nothing to
// rewrite.
void chrome.sidePanel.setOptions({ enabled: false });
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// `tab.url` is only visible for hosts the manifest names, so any other site
// reads as undefined here — which is exactly "not WhatsApp".
chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  void configure(tabId, tab.url);
});

// Tabs already open when the extension is installed or the browser starts:
// nothing will update them until the agent navigates.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.tabs
    .query({ url: `${WHATSAPP_WEB}*` })
    .then((tabs) =>
      Promise.all(tabs.map((tab) => (tab.id === undefined ? null : configure(tab.id, tab.url)))),
    );
});
