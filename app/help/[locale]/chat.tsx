'use client';

import { useEffect } from 'react';
import type { Locale } from '@/lib/kb/locale';

declare global {
  interface Window {
    __shipbluWidget?: { setLocale?: (locale: string) => void };
  }
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
      window.__shipbluWidget?.setLocale?.(locale);
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
