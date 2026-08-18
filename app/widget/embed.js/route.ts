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
 * page of shipblu.com, so it must not be a framework.
 */
export async function GET() {
  const base = publicBaseUrl();

  const script = `(function () {
  'use strict';

  if (window.__shipbluWidget) return;
  window.__shipbluWidget = true;

  var BASE = ${JSON.stringify(base)};
  var script = document.currentScript;
  var locale = (script && script.getAttribute('data-locale')) || 'en';
  var rtl = locale === 'ar';

  var open = false;
  var iframe = null;

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', rtl ? 'المحادثة' : 'Chat with us');
  launcher.style.cssText = [
    'position:fixed',
    'bottom:20px',
    rtl ? 'left:20px' : 'right:20px',
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
    rtl ? 'left:-2px' : 'right:-2px',
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

  function ensureFrame() {
    if (iframe) return iframe;

    iframe = document.createElement('iframe');
    iframe.src = BASE + '/widget?locale=' + encodeURIComponent(locale);
    iframe.title = rtl ? 'محادثة الدعم' : 'Support chat';
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.style.cssText = [
      'position:fixed',
      'bottom:88px',
      rtl ? 'left:20px' : 'right:20px',
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
