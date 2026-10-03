import { publicBaseUrl } from '@/lib/kb/site';
import { HOST_SAYS, SOURCE, WIDGET_SAYS } from '@/lib/widget/protocol';

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

  // Either name: a page can hold a cached copy of the snippet from before the
  // API object was named, and two launchers is the one failure a host page
  // cannot fix from its side.
  if (window.shipbluChat || window.__shipbluWidget) return;

  /*
   * The whole host-page API, claimed before anything else runs so a page
   * carrying the snippet twice still draws one launcher. Every entry is a
   * function *declaration*, so all of them are defined by the time a host page
   * can reach the object.
   *
   * \`__shipbluWidget\` is the name this shipped under and stays an alias: a help
   * centre page held in a back/forward cache still calls it.
   */
  var api = window.shipbluChat = window.__shipbluWidget = {
    identify: identify,
    clear: clear,
    setLocale: setLocale,
    compose: compose,
    open: function () { toggle(true); },
    close: function () { toggle(false); },
    toggle: function () { toggle(); },
    destroy: destroy
  };

  // The names the frame and this script speak to each other, from
  // lib/widget/protocol.ts.
  var SOURCE = ${JSON.stringify(SOURCE)};
  var WIDGET_SAYS = ${JSON.stringify(WIDGET_SAYS)};
  var HOST_SAYS = ${JSON.stringify(HOST_SAYS)};

  var script = document.currentScript;

  /*
   * What the host page set before loading this file — the same shape Freshchat's
   * \`fcWidgetMessengerConfig\` had, so a page moving off it changes the object's
   * name and little else. Read once here; a page whose user changes afterwards
   * calls \`identify()\` rather than mutating it, because nothing watches it.
   */
  var settings = window.shipbluChatSettings || {};

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

  // The attribute wins over the settings object: the help centre keeps it
  // current across a client-side language switch, which is the case that has to
  // be right when both are present.
  var locale = (script && script.getAttribute('data-locale')) || settings.locale || 'en';

  var open = false;
  var iframe = null;

  /*
   * Who the host page says its visitor is, held here until the frame exists and
   * has a session to attach it to. The frame is only built on first open, so an
   * identity handed over at page load waits — which is the right way round: an
   * eager frame would cost every dashboard page view a request for a chat
   * nobody opened.
   */
  var identity = identityFrom(settings);
  var signature = typeof settings.signature === 'string' ? settings.signature : null;
  var frameReady = false;
  var clearPending = false;

  /*
   * Text a host page wants sitting in the composer, held until there is a
   * document to hand it to.
   *
   * \`frameLoaded\` is a weaker fact than \`frameReady\` and has to be: the widget
   * opens on its questions and mints no token until somebody chooses to talk,
   * so \`ready\` — which needs a token — never arrives for a panel that has only
   * ever been looked at. \`hello\`, which the frame posts as soon as it mounts,
   * is what says a document exists. Re-pointing \`src\` starts a new one, so it
   * goes back to false there.
   */
  var composePending = null;
  var frameLoaded = false;

  /*
   * The two layouts, and which one a viewport gets.
   *
   * Narrow *or* short: a phone held sideways is 844x390, which is roomy across
   * and has nowhere to put a 600px card.
   */
  var compact = window.matchMedia('(max-width: 640px), (max-height: 480px)');

  /** The host page's scroll position while it is pinned, or null. */
  var pinned = null;

  /** Set by \`destroy()\`, after which nothing here may reach the page again. */
  var destroyed = false;

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.id = 'shipblu-chat-launcher';
  launcher.style.cssText = [
    'position:fixed',
    'bottom:20px',
    'width:56px',
    'height:56px',
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
   * The launcher's face: a speech bubble with two lines of text in it.
   *
   * Not the 💬 emoji this started as. An emoji is drawn by whatever font the
   * visitor's own device supplies, so the button was Apple's blue speech bubble
   * on an iPhone, Segoe's outline on Windows and something else again on
   * Android — three products, none of them ShipBlu, on the one control that is
   * supposed to say whose support this is.
   *
   * And marked up rather than fetched, which the \`<img>\` it replaces could not
   * be. That request went out cross-origin from the merchant's page, so a
   * strict \`img-src\` on their side blocked it and a bad network dropped it —
   * and the launcher then fell back to the very emoji the mark exists to avoid.
   * An element in the document is subject to no \`img-src\` policy and makes no
   * request, so the face cannot fail to arrive and there is no fallback left to
   * need. That was the only thing under \`public/\`, which is now gone with it.
   *
   * One path, wound so that \`evenodd\` cuts the two lines out as holes rather
   * than painting them in a second copy of the button's blue. Restyle the
   * button and the glyph follows it; a hard-coded #0b6bcb in here would go on
   * showing the old colour in two slots nobody would think to look at.
   */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var mark = document.createElementNS(SVG_NS, 'svg');
  // Both dimensions, in the viewBox's own 3:2. Width alone leaves the height to
  // SVG2's intrinsic sizing, which an older browser answers with 150px — and
  // this file is the one thing on the page that has to render on all of them.
  mark.setAttribute('viewBox', '0 0 24 16');
  mark.setAttribute('width', '24');
  mark.setAttribute('height', '16');
  // The button already carries the label; the glyph would only repeat it. And
  // \`focusable\` because legacy Edge makes an <svg> a tab stop otherwise, which
  // would put a stop with nothing in it inside the button.
  mark.setAttribute('aria-hidden', 'true');
  mark.setAttribute('focusable', 'false');
  // \`pointer-events\` off, so every click lands on the button, never on its
  // contents.
  mark.style.cssText = 'display:block;pointer-events:none';

  var markPath = document.createElementNS(SVG_NS, 'path');
  markPath.setAttribute('fill', '#fff');
  markPath.setAttribute('fill-rule', 'evenodd');
  markPath.setAttribute(
    'd',
    'M4.5,0H19.5A4.5,4.5 0 0 1 24,4.5V11.5A4.5,4.5 0 0 1 19.5,16H4.5A4.5,4.5 0 0 1 0,11.5V4.5A4.5,4.5 0 0 1 4.5,0Z' +
      'M5.2,4.9H18.8A1.2,1.2 0 0 1 18.8,7.3H5.2A1.2,1.2 0 0 1 5.2,4.9Z' +
      'M5.2,8.7H13.8A1.2,1.2 0 0 1 13.8,11.1H5.2A1.2,1.2 0 0 1 5.2,8.7Z'
  );
  mark.appendChild(markPath);

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
    launcher.appendChild(open ? closeGlyph : mark);
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
   *
   * The launcher's own corners are direction-dependent for the same reason, so
   * they are set here rather than in the style attribute. It is ShipBlu's
   * speech bubble rather than a disc: three rounded corners and one drawn
   * almost square, which is the tail. The tail points inwards — bottom-left
   * against a button parked bottom-right, and mirrored in Arabic — because a
   * tail aimed at the corner of the viewport points at nothing, and the shape
   * stops reading as a bubble at all.
   */
  function applyPlacement() {
    var rtl = locale === 'ar';
    var fullScreen = open && compact.matches;

    launcher.style.left = rtl ? '20px' : '';
    launcher.style.right = rtl ? '' : '20px';
    launcher.style.borderRadius = rtl ? '24px 24px 6px 24px' : '24px 24px 24px 6px';
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
      if (iframe.src !== src) {
        iframe.src = src;
        // A new document, which has been told nothing. Anything waiting to be
        // handed over is handed to that one instead, on its \`hello\`.
        frameLoaded = false;
      }
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

  /**
   * Everything the widget will accept as an identity, so a settings object
   * carrying only \`locale\` is not mistaken for one.
   */
  function identityFrom(source) {
    if (!source || typeof source !== 'object') return null;

    var keys = [
      'name', 'firstName', 'lastName', 'email', 'phone',
      'accountId', 'account_id', 'accountName', 'account_name', 'meta'
    ];

    for (var i = 0; i < keys.length; i++) {
      if (source[keys[i]] !== undefined && source[keys[i]] !== null) return source;
    }

    return null;
  }

  /**
   * Open the chat with something already written in the composer.
   *
   * For a host page with a subject of its own — the tracking page's "ask
   * support about this shipment", where the parcel number belongs in the
   * message and the visitor should not have to copy it across. It is a draft
   * and nothing more: the widget puts the text in the box, focuses it and
   * waits, so the visitor writes their own question under it and decides when
   * it goes. Nothing is sent on their behalf.
   *
   * Held rather than posted when the frame is not up yet. \`toggle(true)\` builds
   * it, and a frame that is still loading has no listener — so the text waits
   * for the \`hello\` that says a document exists, exactly as \`clear()\` waits
   * for \`ready\`.
   */
  function compose(text) {
    composePending = typeof text === 'string' ? text : '';
    toggle(true);
    flushCompose();
  }

  function flushCompose() {
    if (composePending === null || !iframe || !frameLoaded) return;

    iframe.contentWindow.postMessage(
      { source: SOURCE.host, type: HOST_SAYS.compose, text: composePending },
      BASE
    );
    // Once only. The frame says \`hello\` again whenever it remounts, and
    // re-delivering the draft then would overwrite whatever the visitor has
    // typed since.
    composePending = null;
  }

  /**
   * Told to us by a host page that knows who is signed in.
   *
   * The signature is optional and is what separates a claim from a fact — see
   * \`lib/widget/identity.ts\`. It may travel as a second argument or as a
   * \`signature\` property, because a dashboard usually gets it from its own
   * backend alongside the rest of the user object.
   */
  function identify(user, userSignature) {
    identity = identityFrom(user);
    signature =
      typeof userSignature === 'string'
        ? userSignature
        : user && typeof user.signature === 'string'
          ? user.signature
          : null;

    pushIdentity();
  }

  /**
   * The host page's user has signed out.
   *
   * This has to survive the frame not existing yet. The visitor token lives in
   * *our* origin's storage, so it outlives the host page's session entirely: a
   * merchant who signs out without ever opening the chat still leaves one
   * behind for whoever signs in next.
   */
  function clear() {
    identity = null;
    signature = null;
    // The draft goes with them. A pending compose belongs to whoever was
    // reading the page that asked for it, and handing it to the next person at
    // this browser is the leak \`clear()\` exists to prevent.
    composePending = null;

    if (iframe && frameReady) {
      iframe.contentWindow.postMessage({ source: SOURCE.host, type: HOST_SAYS.clear }, BASE);
    } else {
      clearPending = true;
    }

    toggle(false);
  }

  function pushIdentity() {
    if (!identity || !iframe || !frameReady) return;

    iframe.contentWindow.postMessage(
      { source: SOURCE.host, type: HOST_SAYS.identify, identity: identity, signature: signature },
      BASE
    );
  }

  function ensureFrame() {
    if (iframe) return iframe;

    /*
     * A host page that calls \`shipbluChat.open()\` from its own head has nothing
     * to append to yet. Returning null rather than throwing leaves the frame to
     * be built by the click on the launcher, which cannot happen before there is
     * a body to draw it in.
     */
    if (destroyed || !document.body) return null;

    iframe = document.createElement('iframe');
    iframe.id = 'shipblu-chat-frame';
    frameLoaded = false;
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
    if (!frame) {
      open = false;
      return;
    }
    frame.style.display = open ? 'block' : 'none';
    paintLauncher();

    if (open && compact.matches) pinPage();
    else releasePage();

    applyPlacement();

    // Told on every open *and* every close, because an iframe cannot detect
    // being shown or hidden on its own — \`display:none\` fires no event inside
    // it. The widget needs both halves: 'opened' is when it marks the transcript
    // read, and without 'closed' a visitor who leaves the panel sitting on the
    // conversation would never be badged for the reply that arrives after they
    // look away.
    if (open) badge.style.display = 'none';
    frame.contentWindow.postMessage(
      { source: SOURCE.host, type: open ? HOST_SAYS.opened : HOST_SAYS.closed },
      BASE
    );
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

  window.addEventListener('message', onMessage);

  function onMessage(event) {
    // The origin check is the whole security of this listener: without it any
    // page could post a message that opens the widget or fakes an unread count.
    if (event.origin !== BASE) return;

    var data = event.data;
    if (!data || data.source !== SOURCE.widget) return;

    /*
     * The frame has a session and can be told things. Sent again after the
     * widget starts a fresh one, which is why the identity is pushed rather
     * than assumed to have survived.
     */
    if (data.type === WIDGET_SAYS.ready) {
      frameReady = true;
      frameLoaded = true;

      if (clearPending) {
        clearPending = false;
        iframe.contentWindow.postMessage({ source: SOURCE.host, type: HOST_SAYS.clear }, BASE);
        return;
      }

      pushIdentity();
      flushCompose();
    }

    /*
     * The frame asking whether it is visible.
     *
     * Distinct from 'ready', which the widget only sends once it has a session:
     * it now opens on the questions and mints no token until somebody chooses to
     * talk, so a panel showing FAQs would never ask. And it cannot work this out
     * for itself — the 'opened' posted when this script *creates* the frame
     * lands on about:blank, a close before the frame loads is lost the same way,
     * and \`setLocale\` re-points \`src\` and starts a new document. Left
     * assuming it is visible, a hidden panel silently swallows the unread badge.
     */
    if (data.type === WIDGET_SAYS.hello) {
      frameLoaded = true;

      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          { source: SOURCE.host, type: open ? HOST_SAYS.opened : HOST_SAYS.closed },
          BASE
        );
      }

      // After the visibility answer, so the panel knows it is on screen before
      // it is given something to say — the draft arriving first would land in a
      // thread the widget still believes nobody is looking at.
      flushCompose();
      return;
    }

    if (data.type === WIDGET_SAYS.unread) {
      var count = Number(data.count) || 0;
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.style.display = count > 0 && !open ? 'flex' : 'none';
    }

    if (data.type === WIDGET_SAYS.close) toggle(false);
  }

  /**
   * Take back off the page everything this script put on it, and stand down.
   *
   * For a host page that leaves the part of itself carrying the chat without
   * a reload. The launcher and the frame hang off \`document.body\`, outside
   * anything a framework renders, so a single-page app navigating away leaves
   * them behind on whatever it shows next — which is how the help centre's
   * launcher came to sit over the agent console, once an agent signed in from
   * the help centre's header and landed in their inbox without the page ever
   * being replaced.
   *
   * The listeners and the API names go with the elements, so loading the
   * snippet again later runs a fresh copy rather than being turned away by the
   * duplicate guard at the top. A reference a page kept to the old object can
   * still be called, and reaches nothing: the frame is never rebuilt and the
   * launcher never re-appended. The visitor's token stays where it is — this
   * removes a chat from the page, it does not sign anyone out of one, which is
   * what \`clear()\` is for.
   */
  function destroy() {
    if (destroyed) return;
    destroyed = true;

    // First: a panel open full screen on a phone has pinned the host page's
    // body, and the page the visitor is moving to cannot scroll until it is
    // let go.
    open = false;
    releasePage();

    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('orientationchange', onViewportChange);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onViewportChange);
      window.visualViewport.removeEventListener('scroll', onViewportChange);
    }
    window.removeEventListener('message', onMessage);
    document.removeEventListener('DOMContentLoaded', mount);

    // The tag too: it is what a host page checks for before adding one, and a
    // page that finds it would conclude the chat is already there.
    [launcher, iframe, sheet, script].forEach(function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    iframe = null;

    if (window.shipbluChat === api) delete window.shipbluChat;
    if (window.__shipbluWidget === api) delete window.__shipbluWidget;
  }

  function mount() {
    if (destroyed) return;
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
