import { createContext, useContext, useEffect, useEffectEvent, useState } from 'react';
import { isChatState, isChatUpdate, type ChatState, type PanelRequest } from '../messages';
import { ApiError, SignedOut } from './api';

/**
 * The panel's two sources of truth: the WhatsApp tab beside it, and the console.
 */

export type ChatConnection =
  | { status: 'connecting' }
  /** No content script answered — WhatsApp Web was open before the extension was. */
  | { status: 'unreachable' }
  | { status: 'ready'; state: ChatState };

/**
 * The chat open in the WhatsApp Web tab this panel belongs to.
 *
 * The panel is enabled per tab (`background.ts`), so the active tab when it
 * opens is its own. It asks the content script once, then listens for the
 * updates that script announces — keeping only those from its own tab, since
 * every panel in every window hears every announcement.
 */
export function useChat(): ChatConnection {
  const [connection, setConnection] = useState<ChatConnection>({ status: 'connecting' });

  useEffect(() => {
    let cancelled = false;
    let tabId: number | undefined;

    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return undefined;
      if (sender.tab.id === tabId && isChatUpdate(message)) {
        setConnection({ status: 'ready', state: message.state });
      }
      return undefined;
    };
    chrome.runtime.onMessage.addListener(onMessage);

    void (async () => {
      const id = requestedTab() ?? (await activeTab());
      if (cancelled || id === undefined) return;
      tabId = id;
      try {
        const request: PanelRequest = { type: 'get-chat' };
        const state: unknown = await chrome.tabs.sendMessage(id, request);
        if (!cancelled) {
          setConnection(
            isChatState(state) ? { status: 'ready', state } : { status: 'unreachable' },
          );
        }
      } catch {
        if (!cancelled) setConnection({ status: 'unreachable' });
      }
    })();

    return () => {
      cancelled = true;
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  return connection;
}

async function activeTab(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

/**
 * `panel.html?tab=<id>` reads that tab instead of the active one. For opening
 * the panel in a tab of its own while debugging — where the active tab is the
 * panel itself — and for the browser check in `extension/README.md`.
 */
function requestedTab(): number | undefined {
  const value = Number(new URLSearchParams(window.location.search).get('tab'));
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Called when any request finds the session over, so the panel returns to sign-in. */
export const SignedOutContext = createContext<() => void>(() => {});

export type Polled<T> = {
  data: T | undefined;
  error: ApiError | null;
  /** True until the first answer for this `key`. */
  loading: boolean;
  reload: () => void;
};

/**
 * A console read, kept fresh while the panel is visible.
 *
 * `key` names the request: a new key drops the old answer rather than showing
 * one ticket's shipments under another's header while the next ones load.
 * Thirty seconds by default — the console's own ticket page updates live, but
 * an SSE stream through an extension page that Chrome may suspend is not worth
 * it for parcels whose status changes a few times a day.
 */
export function usePolled<T>(key: string | null, load: () => Promise<T>, everyMs = 30_000) {
  const onSignedOut = useContext(SignedOutContext);
  const [answer, setAnswer] = useState<{ key: string; data?: T; error: ApiError | null }>();
  const [version, setVersion] = useState(0);

  const fetchOnce = useEffectEvent(async (forKey: string, isCancelled: () => boolean) => {
    try {
      const data = await load();
      if (!isCancelled()) setAnswer({ key: forKey, data, error: null });
    } catch (error) {
      if (isCancelled()) return;
      if (error instanceof SignedOut) {
        onSignedOut();
        return;
      }
      setAnswer((previous) => ({
        key: forKey,
        // A failed refresh keeps what was on screen: a dropped connection is
        // not a reason to blank the parcels the agent is reading out.
        data: previous?.key === forKey ? previous.data : undefined,
        error: error instanceof ApiError ? error : new ApiError('Something went wrong', 0),
      }));
    }
  });

  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const isCancelled = () => cancelled;

    void fetchOnce(key, isCancelled);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchOnce(key, isCancelled);
    }, everyMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, version, everyMs]);

  const current = answer?.key === key ? answer : undefined;
  return {
    data: current?.data,
    error: current?.error ?? null,
    loading: key !== null && current === undefined,
    reload: () => setVersion((value) => value + 1),
  } satisfies Polled<T>;
}

/**
 * A write the agent presses a button for: busy while it runs, the server's
 * sentence when it refuses, and the session handed back if it has ended.
 */
export function useWrite() {
  const onSignedOut = useContext(SignedOutContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(write: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await write();
      return true;
    } catch (caught) {
      if (caught instanceof SignedOut) onSignedOut();
      else setError(caught instanceof ApiError ? caught.message : 'Something went wrong');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}
