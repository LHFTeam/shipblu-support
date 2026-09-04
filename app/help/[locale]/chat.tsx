'use client';

import { useEffect } from 'react';
import type { Locale } from '@/lib/kb/locale';

/**
 * The half of the snippet's host API the help centre calls.
 *
 * Every entry optional, and that is not defensiveness for its own sake: the
 * snippet is cached for five minutes and a page held in a back/forward cache
 * can be running a copy from before a method existed. A caller checks for the
 * one it wants and falls back rather than throwing inside a click handler.
 */
type ShipbluChat = {
  setLocale?: (locale: string) => void;
  open?: () => void;
  compose?: (text: string) => void;
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
 * Live chat on the help centre.
 *
 * The help centre loads the same `/widget/embed.js` a merchant would paste into
 * their own site rather than a second launcher written in React. One
 * implementation to fix, and the chat still runs inside the widget's iframe,
 * where `.kb-shell`'s palette and typefaces cannot reach it and its polling
 * cannot slow a page down.
 *
 * The tag is injected here instead of being written into the layout because the
 * language switcher is a client-side navigation: the layout re-renders in the
 * other language without the document being replaced, so nothing would reload
 * the snippet and the widget would keep answering in the language the visitor
 * arrived in, from the wrong side of the screen. The element is created once,
 * and both halves of the handover are kept current — `data-locale` for a switch
 * that lands before the file has finished loading, `setLocale` for one that
 * lands after.
 *
 * Nothing is rendered: the snippet appends the launcher to `document.body`
 * itself, which is what it does on every other host page.
 */
export function ChatWidget({ locale }: { locale: Locale }) {
  useEffect(() => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;

    if (existing) {
      existing.dataset.locale = locale;
      chatWidget()?.setLocale?.(locale);
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    // Relative on purpose: whichever hostname served this page serves the
    // snippet and the iframe too, so the frame is same-origin with the page on
    // the custom domain and on the service URL alike.
    script.src = '/widget/embed.js';
    script.async = true;
    script.dataset.locale = locale;
    document.body.appendChild(script);
  }, [locale]);

  return null;
}
