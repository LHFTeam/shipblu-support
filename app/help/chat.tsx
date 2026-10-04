'use client';

import { useEffect, useLayoutEffect } from 'react';
import { useParams } from 'next/navigation';
import { isLocale, type Locale } from '@/lib/kb/locale';

/**
 * The half of the snippet's host API the help centre calls.
 *
 * Every entry optional, and that is not defensiveness for its own sake: a page
 * held in a back/forward cache can be running a copy from before a method
 * existed. A caller checks for the one it wants and falls back rather than
 * throwing inside a click handler.
 */
type ShipbluChat = {
  setLocale?: (locale: string) => void;
  open?: () => void;
  compose?: (text: string) => void;
  destroy?: () => void;
};

declare global {
  interface Window {
    shipbluChat?: ShipbluChat;
    /** The name this shipped under, which the snippet still aliases. */
    __shipbluWidget?: ShipbluChat;
  }
}

/**
 * The snippet's API, or null while it is still loading.
 *
 * `ChatWidget` appends the tag with `async`, so a visitor who reaches a button
 * within the first moment of the page finds nothing here. Every caller is a
 * progressive enhancement over a link that already worked.
 */
export function chatWidget(): ShipbluChat | null {
  if (typeof window === 'undefined') return null;
  return window.shipbluChat ?? window.__shipbluWidget ?? null;
}

const SCRIPT_ID = 'shipblu-chat-embed';

/**
 * The snippet's URL, carrying a cache key that is the help centre's alone.
 *
 * `embed.js` is cached for five minutes, and this page needs a copy that has
 * `destroy()`. Without the key, a browser that fetched the snippet just before
 * the deploy that added it would hand that copy to the new page, and leaving
 * the help centre would leave its launcher behind. The server ignores the query
 * and the snippet reads only the origin from its own URL, so the key changes
 * the cache entry and nothing else, and no merchant's tag is touched. Change it
 * when this file starts relying on something newer in the snippet.
 *
 * Relative on purpose: whichever hostname served this page serves the snippet
 * and the iframe too, so the frame is same-origin with the page on the custom
 * domain and on the service URL alike.
 */
const SCRIPT_SRC = '/widget/embed.js?v=2';

/**
 * Whether a help-centre page is on screen, for a snippet that lands after the
 * reader has left one.
 */
let shown = false;

/**
 * The chat for `locale`, loading it if this document has none yet.
 *
 * The element is created once, and both halves of a language switch are kept
 * current: `data-locale` for one that lands before the file has finished
 * loading, `setLocale` for one that lands after.
 */
export function showChat(locale: Locale) {
  shown = true;

  const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    existing.dataset.locale = locale;
    chatWidget()?.setLocale?.(locale);
    return;
  }

  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.src = SCRIPT_SRC;
  script.async = true;
  script.dataset.locale = locale;

  // Listened for once, here, rather than by whoever leaves while it is still on
  // its way. Removing the tag would not stop it: an async script runs when it
  // arrives whether or not it is still in the document, so a reader who has
  // left by then gets it taken straight back down.
  script.addEventListener('load', () => {
    if (!shown) chatWidget()?.destroy?.();
  });
  // A tag whose file never came (an ad blocker, a dropped connection) would
  // otherwise read as a chat already loading, and nothing would try again until
  // a full reload.
  script.addEventListener('error', () => script.remove());

  document.body.appendChild(script);
}

/**
 * Take the chat off the page, for a reader who has left the help centre.
 *
 * The snippet hangs its launcher off `document.body`, which no client-side
 * navigation replaces, so the launcher used to outlive the layout that loaded
 * it. An agent who signed in on the help centre landed in the console without
 * the page ever being reloaded, and found a customer's chat button floating
 * over their inbox (`docs/PROJECT-STATE.md` §6.78).
 */
export function hideChat() {
  shown = false;
  chatWidget()?.destroy?.();
}

/**
 * Live chat on the help centre.
 *
 * The help centre loads the same `/widget/embed.js` a merchant would paste into
 * their own site rather than a second launcher written in React. One
 * implementation to fix, and the chat still runs inside the widget's iframe,
 * where `.kb-shell`'s palette and typefaces cannot reach it and its polling
 * cannot slow a page down.
 *
 * Rendered from `app/help/layout.tsx`, above the locale segment, and that
 * placement is what lets the teardown be this plain. The `[locale]` layout is
 * replaced on a language switch — the locale is part of its key — so a
 * `ChatWidget` inside it unmounts on every switch, and taking the chat down on
 * unmount would close an open conversation each time. Up here the switch is a
 * change of the locale it reads, so an unmount means the help centre has gone:
 * the reader navigated out of it, or the team-member gate beside it now says
 * no.
 *
 * The teardown is a layout effect so it lands in the same commit that draws
 * the next page. A passive effect runs after the browser has painted, and an
 * agent arriving in the console would see one frame of a customer's chat over
 * their inbox — the whole screen of it, if the panel was open on a phone.
 *
 * Nothing is rendered: the snippet appends the launcher to `document.body`
 * itself, which is what it does on every other host page.
 */
export function ChatWidget() {
  const params = useParams<{ locale?: string }>();
  // Read from the route rather than passed down, because the layout rendering
  // this sits above the segment that holds it. Anything but a locale is a path
  // on its way to the root 404, which unmounts this anyway; nothing to load.
  const locale = isLocale(params?.locale) ? params.locale : null;

  // Nothing to do on mount; leaving is the whole of it.
  useLayoutEffect(() => hideChat, []);

  useEffect(() => {
    if (locale) showChat(locale);
  }, [locale]);

  return null;
}
