import { publicBaseUrl } from '@/lib/kb/site';

export const dynamic = 'force-dynamic';

/**
 * The embed snippet, served as JavaScript.
 *
 * Everything the host page runs is this file: it draws a launcher button and,
 * on first open, an iframe pointing at /widget. The chat itself lives entirely
 * inside that iframe, which is what keeps the host page's CSS out of the widget
 * and the widget's scripts out of the host page — and it means the visitor
 * token lives in *our* origin's localStorage, not the host site's, so embedding
 * the widget never hands the host access to a customer's conversation.
 *
 * Deliberately dependency-free and small enough to read: this runs on every
 * page of shipblu.com and of the help centre, so it must not be a framework.
 */
export async function GET() {
  const base = publicBaseUrl();

  const script = `(function () {
  'use strict';

  if (window.__shipbluWidget) return;

  // Claimed before anything else runs, so a page carrying the snippet twice
  // still draws one launcher. \`setLocale\` is a function declaration, so it is
  // already defined by the time a host page can reach it.
  window.__shipbluWidget = { setLocale: setLocale };

  var script = document.currentScript;

  /*
   * The origin the widget is served from.
   *
   * Read from this script's own URL rather than baked in, because the site
   * carrying the widget is often one of ours and reachable on more than one
   * hostname: the help centre answers on its custom domain and on the Render
   * service URL, and the console serves /widget too. A baked-in base would
   * frame the other hostname, which is a different origin — so the visitor
   * would need that origin in WIDGET_ALLOWED_ORIGINS before the frame loaded
   * at all, and would otherwise open an empty box. Taking the origin from the
   * snippet's own URL keeps the iframe same-origin with the page on every one
   * of our surfaces, which \`frame-ancestors 'self'\` already allows, while a
   * genuine third-party host still gets the origin it pasted into its tag.
   *
   * The configured base remains the fallback for the one case with no element
   * to read: a snippet injected where \`currentScript\` is unavailable.
   */
  var BASE = ${JSON.stringify(base)};
  if (script && script.src) {
    try {
      BASE = new URL(script.src, window.location.href).origin;
    } catch (error) {
      // Keeps the configured base.
    }
  }

  var locale = (script && script.getAttribute('data-locale')) || 'en';

  var open = false;
  var iframe = null;

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.id = 'shipblu-chat-launcher';
  launcher.style.cssText = [
    'position:fixed',
    'bottom:20px',
    'width:56px',
    'height:56px',
    'border-radius:28px',
    'border:0',
    'background:#0b6bcb',
    'color:#fff',
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(0,0,0,.25)',
    'z-index:2147483000',
    'font-size:24px',
    'line-height:1',
    'display:flex',
    'align-items:center',
    'justify-content:center'
  ].join(';');
  launcher.textContent = '💬';

  var badge = document.createElement('span');
  badge.style.cssText = [
    'position:absolute',
    'top:-2px',
    'min-width:18px',
    'height:18px',
    'border-radius:9px',
    'background:#dc2626',
    'color:#fff',
    'font-size:11px',
    'font-weight:600',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'padding:0 4px'
  ].join(';');
  launcher.appendChild(badge);

  /*
   * A button that floats over the page is the one thing on it with no business
   * being on paper, and help centre articles are printed and handed to a
   * colleague. A stylesheet rather than inline styles because a media query
   * cannot go in a style attribute; keyed on our two ids so it changes nothing
   * else on the host page.
   */
  var sheet = document.createElement('style');
  sheet.textContent =
    '@media print{#shipblu-chat-launcher,#shipblu-chat-frame{display:none !important}}';
  document.head.appendChild(sheet);

  function frameSrc() {
    return BASE + '/widget?locale=' + encodeURIComponent(locale);
  }

  /**
   * Everything that differs between the two languages, in one place so that a
   * language switch can re-apply it. The launcher sits on the side the reader's
   * eye ends on, which is the other side in Arabic — a chat button pinned to
   * the bottom right of an Arabic page reads as something the site forgot to
   * translate.
   */
  function applyLocale() {
    var rtl = locale === 'ar';

    launcher.setAttribute('aria-label', rtl ? 'المحادثة' : 'Chat with us');
    launcher.style.left = rtl ? '20px' : '';
    launcher.style.right = rtl ? '' : '20px';
    badge.style.left = rtl ? '-2px' : '';
    badge.style.right = rtl ? '' : '-2px';

    if (!iframe) return;

    iframe.title = rtl ? 'محادثة الدعم' : 'Support chat';
    iframe.style.left = rtl ? '20px' : '';
    iframe.style.right = rtl ? '' : '20px';

    // Only when it actually changed: assigning the same src reloads the frame,
    // which would throw away a half-typed message every time this runs.
    var src = frameSrc();
    if (iframe.src !== src) iframe.src = src;
  }

  /**
   * Told to us by a host page whose own language changes without a reload. The
   * help centre's language switcher is a client-side navigation, so without
   * this an Arabic page would keep an English widget parked on the wrong side
   * of the screen until the visitor happened to reload.
   *
   * Re-pointing the iframe reloads the chat in the other language. The
   * transcript survives that: it is read back from the server against the
   * visitor token in our origin's localStorage rather than held in the frame.
   */
  function setLocale(next) {
    if (next !== 'en' && next !== 'ar') return;
    if (next === locale) return;

    locale = next;
    applyLocale();
  }

  // The launcher is styled as soon as it exists rather than as it is inserted,
  // so a language switch that lands before the page is ready still finds it in
  // the right place.
  applyLocale();

  function ensureFrame() {
    if (iframe) return iframe;

    iframe = document.createElement('iframe');
    iframe.id = 'shipblu-chat-frame';
    iframe.src = frameSrc();
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.style.cssText = [
      'position:fixed',
      'bottom:88px',
      'width:380px',
      'height:min(600px, calc(100vh - 120px))',
      'max-width:calc(100vw - 40px)',
      'border:0',
      'border-radius:12px',
      'box-shadow:0 10px 40px rgba(0,0,0,.2)',
      'z-index:2147483000',
      'display:none',
      'background:#fff',
      'color-scheme:light'
    ].join(';');

    // Sets the title and the side it opens on. The src it would set is the one
    // just assigned, so the frame is not loaded twice.
    applyLocale();

    document.body.appendChild(iframe);
    return iframe;
  }

  function toggle(next) {
    open = next === undefined ? !open : next;
    var frame = ensureFrame();
    frame.style.display = open ? 'block' : 'none';
    launcher.textContent = open ? '✕' : '💬';
    launcher.appendChild(badge);

    if (open) {
      badge.style.display = 'none';
      // Told on every open so the widget can mark the transcript read and
      // focus its input — an iframe cannot detect being shown on its own.
      frame.contentWindow.postMessage({ source: 'shipblu-host', type: 'opened' }, BASE);
    }
  }

  launcher.addEventListener('click', function () {
    toggle();
  });

  window.addEventListener('message', function (event) {
    // The origin check is the whole security of this listener: without it any
    // page could post a message that opens the widget or fakes an unread count.
    if (event.origin !== BASE) return;

    var data = event.data;
    if (!data || data.source !== 'shipblu-widget') return;

    if (data.type === 'unread') {
      var count = Number(data.count) || 0;
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.style.display = count > 0 && !open ? 'flex' : 'none';
    }

    if (data.type === 'close') toggle(false);
  });

  function mount() {
    document.body.appendChild(launcher);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
`;

  return new Response(script, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Short, so a fix to the snippet reaches host pages the same day, but
      // long enough that it is not refetched on every navigation.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
