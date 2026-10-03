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
  close?: () => void;
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
 * How many help-centre layouts are on screen, and the teardown waiting to see
 * whether another arrives.
 *
 * Module state rather than a ref because the question spans instances. The
 * language switch does not re-render the layout, it replaces it — the locale is
 * part of its segment key — so one `ChatWidget` unmounts and the next mounts in
 * the same commit, and tearing down on unmount alone would close an open
 * conversation on every switch. React runs a commit's cleanups before any of
 * its new effects, so a teardown deferred by one task is cancelled by the mount
 * that replaces it, and goes ahead only when nothing did: when the reader has
 * left the help centre.
 *
 * That holds because both layouts change in one commit, which nothing above
 * this one prevents today. A `loading.tsx` at `app/` or `app/help/` would give
 * each locale a Suspense boundary of its own, the fallback could commit between
 * the two, and an open chat would close on every language switch. That would
 * be a regression, not a leak, because the teardown would still run.
 */
let mounted = 0;
let pendingTeardown: ReturnType<typeof setTimeout> | null = null;

/**
 * Take the chat off the page, for a reader who has left the help centre.
 *
 * The snippet hangs its launcher off `document.body`, which no navigation
 * inside the app replaces, so the launcher used to outlive the layout that
 * loaded it. An agent who signed in from the help centre's header landed in
 * the console without the page ever being reloaded, and found a customer's chat
 * button floating over their inbox (`docs/PROJECT-STATE.md` §6.78).
 */
function removeChat() {
  const api = chatWidget();

  if (api?.destroy) {
    api.destroy();
    return;
  }

  const tag = document.getElementById(SCRIPT_ID);

  if (!api) {
    // Still on its way: removing the tag would not stop it, and it will run
    // wherever the reader is when it lands. So it is taken down the moment it
    // has, unless they came back meanwhile.
    tag?.addEventListener(
      'load',
      () => {
        if (mounted === 0) removeChat();
      },
      { once: true },
    );
    return;
  }

  // A copy cached from before `destroy()` existed, at most five minutes after
  // the deploy that added it. It can be hidden but not stood down, because its
  // listeners cannot be reached from here. So it keeps its names, and the guard
  // at the top of the snippet stops a second copy from starting beside it and
  // having its frame's messages answered by this one. Chat comes back with the
  // next full page load.
  api.close?.();
  document.getElementById('shipblu-chat-launcher')?.remove();
  document.getElementById('shipblu-chat-frame')?.remove();
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
 * The tag is injected here instead of being written into the layout because the
 * language switcher is a client-side navigation: the layout is rebuilt in the
 * other language without the document being replaced, so nothing would reload
 * the snippet and the widget would keep answering in the language the visitor
 * arrived in, from the wrong side of the screen. The element is created once,
 * and both halves of the handover are kept current — `data-locale` for a switch
 * that lands before the file has finished loading, `setLocale` for one that
 * lands after.
 *
 * Nothing is rendered: the snippet appends the launcher to `document.body`
 * itself, which is what it does on every other host page. So nothing React
 * does removes it either, and leaving the help centre has to say so — see
 * `removeChat`.
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

  useEffect(() => {
    mounted += 1;
    if (pendingTeardown !== null) {
      clearTimeout(pendingTeardown);
      pendingTeardown = null;
    }

    return () => {
      mounted -= 1;
      if (mounted > 0) return;

      if (pendingTeardown !== null) clearTimeout(pendingTeardown);
      pendingTeardown = setTimeout(() => {
        pendingTeardown = null;
        if (mounted === 0) removeChat();
      }, 0);
    };
  }, []);

  return null;
}
