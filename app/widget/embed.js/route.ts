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

  /*
   * The two layouts, and which one a viewport gets.
   *
   * Narrow *or* short: a phone held sideways is 844x390, which is roomy across
   * and has nowhere to put a 600px card.
   */
  var compact = window.matchMedia('(max-width: 640px), (max-height: 480px)');

  /** The host page's scroll position while it is pinned, or null. */
  var pinned = null;

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

  /*
   * The launcher's face.
   *
   * An <img> rather than the 💬 emoji this used to be. An emoji is drawn by
   * whatever font the visitor's own device supplies, so the button was Apple's
   * blue speech bubble on an iPhone, Segoe's outline on Windows and something
   * else again on Android — three products, none of them ShipBlu, on the one
   * control that is supposed to say whose support this is.
   *
   * Served from /widget/ rather than anywhere else under public/, and that is
   * load-bearing rather than tidy: \`/widget\` is already the one prefix
   * \`proxy.ts\` lets through without a session *and* leaves unrewritten on the
   * help-centre hostname. An asset one directory to the side would redirect a
   * visitor on a merchant's site to /login, and 404 under /help on the custom
   * domain.
   */
  var markFailed = false;
  var mark = document.createElement('img');
  mark.src = BASE + '/widget/logomark-white.png';
  mark.alt = '';
  // The mark is wider than it is tall, so height follows width rather than
  // being set: a host page's own \`img\` rules cannot squash it. And
  // \`pointer-events\` off, so every click lands on the button, never on its
  // contents.
  mark.style.cssText = 'width:30px;height:auto;display:block;pointer-events:none';

  /*
   * The mark is the only thing in the button, so a request that fails leaves a
   * blank blue disc with no hint that it opens anything. The emoji is the worse
   * mark and the better fallback: it needs nothing from the network, which is
   * the one thing that has just gone wrong.
   */
  mark.addEventListener('error', function () {
    markFailed = true;
    paintLauncher();
  });

  var closeGlyph = document.createElement('span');
  closeGlyph.textContent = '✕';
  closeGlyph.style.cssText = 'pointer-events:none';

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
  /*
   * Rebuilt rather than assigned. The badge is a child of the launcher, so the
   * \`textContent =\` this replaced deleted it on every toggle and had to
   * put it back afterwards; with an element to swap in, that trick stops
   * working at all.
   */
  function paintLauncher() {
    while (launcher.firstChild) launcher.removeChild(launcher.firstChild);
    if (open) launcher.appendChild(closeGlyph);
    else if (markFailed) launcher.appendChild(document.createTextNode('💬'));
    else launcher.appendChild(mark);
    launcher.appendChild(badge);
  }

  paintLauncher();

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
   * Where the launcher and the panel sit.
   *
   * Two layouts rather than one that stretches. On a phone the panel takes the
   * whole screen, because a 380px card floating 88px above the bottom edge puts
   * the composer exactly where the software keyboard opens over it — and what
   * the visitor then does is scroll to find it. Anywhere with room to spare it
   * stays the card, which is the point of a widget on a desktop page.
   *
   * The full-screen size comes from \`visualViewport\` rather than from \`100vh\`,
   * because on iOS \`100vh\` keeps counting the strip the keyboard now covers.
   * \`offsetTop\` is what keeps a fixed element aligned with the visible area
   * once the keyboard has scrolled the visual viewport inside the layout one.
   *
   * Both the side the launcher sits on and the side the card opens from are
   * here too: the reader's eye ends on the other side in Arabic, and a chat
   * button pinned bottom-right of an Arabic page reads as something the site
   * forgot to translate.
   */
  function applyPlacement() {
    var rtl = locale === 'ar';
    var fullScreen = open && compact.matches;

    launcher.style.left = rtl ? '20px' : '';
    launcher.style.right = rtl ? '' : '20px';
    badge.style.left = rtl ? '-2px' : '';
    badge.style.right = rtl ? '' : '-2px';
    // Nothing to return to on a full screen, and the panel carries its own
    // close button.
    launcher.style.display = fullScreen ? 'none' : 'flex';

    if (!iframe) return;

    if (fullScreen) {
      var viewport = window.visualViewport;

      iframe.style.top = (viewport ? viewport.offsetTop : 0) + 'px';
      iframe.style.bottom = 'auto';
      iframe.style.left = '0px';
      iframe.style.right = 'auto';
      iframe.style.width = '100%';
      iframe.style.maxWidth = 'none';
      iframe.style.height = (viewport ? viewport.height : window.innerHeight) + 'px';
      iframe.style.borderRadius = '0';
      return;
    }

    iframe.style.top = 'auto';
    iframe.style.bottom = '88px';
    iframe.style.left = rtl ? '20px' : 'auto';
    iframe.style.right = rtl ? 'auto' : '20px';
    iframe.style.width = '380px';
    iframe.style.maxWidth = 'calc(100vw - 40px)';
    iframe.style.height = 'min(600px, calc(100vh - 120px))';
    iframe.style.borderRadius = '12px';
  }

  /**
   * The host page must not scroll while a full-screen panel is over it.
   *
   * This is not tidiness. On iOS the text caret is positioned against the
   * document rather than against the fixed element the input belongs to, so a
   * page that scrolls behind the chat drags the visitor's cursor out of the
   * field they are typing in — and the keyboard opening is itself a scroll,
   * because Safari scrolls the document to reveal a focused input. Pinning the
   * body is what keeps the caret and the field together.
   *
   * \`position: fixed\` rather than \`overflow: hidden\`, which Safari ignores on
   * the body; the offset is kept so the page comes back exactly where it was
   * rather than at the top.
   */
  function pinPage() {
    if (pinned) return;

    var body = document.body;
    var offset = window.pageYOffset || document.documentElement.scrollTop || 0;

    pinned = {
      offset: offset,
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width
    };

    body.style.position = 'fixed';
    body.style.top = -offset + 'px';
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
  }

  function releasePage() {
    if (!pinned) return;

    var body = document.body;

    body.style.position = pinned.position;
    body.style.top = pinned.top;
    body.style.left = pinned.left;
    body.style.right = pinned.right;
    body.style.width = pinned.width;
    window.scrollTo(0, pinned.offset);

    pinned = null;
  }

  /** Language, and nothing about position. */
  function applyLocale() {
    var rtl = locale === 'ar';

    launcher.setAttribute('aria-label', rtl ? 'المحادثة' : 'Chat with us');

    if (iframe) {
      iframe.title = rtl ? 'محادثة الدعم' : 'Support chat';

      // Only when it actually changed: assigning the same src reloads the
      // frame, which would throw away a half-typed message every time this
      // runs.
      var src = frameSrc();
      if (iframe.src !== src) iframe.src = src;
    }

    applyPlacement();
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
    // Everything except its size and position, which \`applyPlacement\` owns —
    // they depend on the viewport it is opening into and change under it.
    iframe.style.cssText = [
      'position:fixed',
      'border:0',
      'box-shadow:0 10px 40px rgba(0,0,0,.2)',
      'z-index:2147483000',
      'display:none',
      'background:#fff',
      'color-scheme:light'
    ].join(';');

    // Sets the title and lays it out. The src it would set is the one just
    // assigned, so the frame is not loaded twice.
    applyLocale();

    document.body.appendChild(iframe);
    return iframe;
  }

  function toggle(next) {
    open = next === undefined ? !open : next;
    var frame = ensureFrame();
    frame.style.display = open ? 'block' : 'none';
    paintLauncher();

    if (open && compact.matches) pinPage();
    else releasePage();

    applyPlacement();

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

  /**
   * The keyboard opening, a rotation and a resized window all arrive here, and
   * any of the three can move the boundary between the two layouts — so which
   * layout applies is re-decided rather than remembered from the open.
   */
  function onViewportChange() {
    if (!open) return;

    if (compact.matches) pinPage();
    else releasePage();

    applyPlacement();
  }

  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  if (window.visualViewport) {
    // \`scroll\` as well as \`resize\`: on iOS the keyboard does not resize the
    // visual viewport so much as scroll it inside the layout viewport, and the
    // panel has to follow it down.
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
  }

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
