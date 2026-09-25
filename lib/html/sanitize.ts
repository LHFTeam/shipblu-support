import sanitizeHtml from 'sanitize-html';
import { convert } from 'html-to-text';

/**
 * Email HTML is attacker-controlled input. Anyone can email support@shipblu.com,
 * so a stored-XSS payload in a ticket body would execute in an agent's session —
 * an agent who is authenticated and can read every customer's data.
 *
 * Everything is sanitised on the way *in* (before storage) and the console
 * additionally renders bodies inside a sandboxed iframe, so a gap in either
 * layer alone is not exploitable.
 */

const ALLOWED_TAGS = [
  'p',
  'div',
  'span',
  'br',
  'hr',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'sub',
  'sup',
  'mark',
  'small',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'code',
  'a',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
];

export type SanitiseOptions = {
  /**
   * Remote images are tracking pixels as often as they are content: loading them
   * tells the sender exactly when an agent opened the ticket, and leaks the
   * agent's IP. Blocked by default; the console offers a per-message
   * "load images" action, mirroring how mail clients behave.
   */
  allowRemoteImages?: boolean;
};

export function sanitiseEmailHtml(html: string, options: SanitiseOptions = {}): string {
  const { allowRemoteImages = false } = options;

  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'cid'],
      // Inline styles are how email does layout; dropping them entirely makes
      // most messages unreadable. Restricted to safe properties below.
      '*': ['style', 'align', 'dir', 'lang'],
      table: ['border', 'cellpadding', 'cellspacing', 'width'],
      td: ['colspan', 'rowspan', 'width', 'height', 'valign'],
      th: ['colspan', 'rowspan', 'width', 'height', 'valign'],
      col: ['span', 'width'],
    },

    // Only these schemes. Notably excludes javascript: and data: — data: URLs
    // can carry text/html and become a script execution vector.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: {
      // cid: is how inline attachments are referenced; rewritten to a real URL
      // after the attachment is stored.
      img: allowRemoteImages ? ['http', 'https', 'cid'] : ['cid'],
    },
    allowProtocolRelative: false,

    allowedStyles: {
      '*': {
        color: [/^.*$/],
        'background-color': [/^.*$/],
        'text-align': [/^(left|right|center|justify)$/],
        'font-size': [/^\d+(?:\.\d+)?(?:px|em|rem|pt|%)$/],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^[a-z- ]+$/],
        'font-family': [/^[\w\s,'"-]+$/],
        margin: [/^[\d\s.a-z%-]+$/],
        padding: [/^[\d\s.a-z%-]+$/],
        border: [/^[\d\s.a-z#()%,-]+$/],
        width: [/^[\d.]+(?:px|em|rem|%)$/],
        // Deliberately absent: position, z-index, transform, and anything that
        // could lift content out of the message and over the console's own UI.
      },
    },

    transformTags: {
      // Untrusted links must not get window.opener access to the console, and
      // should not leak the ticket URL through the Referer header.
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      }),
    },

    // Strip these entirely, including their contents. Without this the *text* of
    // a <script> block survives as visible body text.
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title'],

    disallowedTagsMode: 'discard',
  });
}

/**
 * Plain-text fallback, used when a message has no text part, and as the source
 * for the search vector and inbox previews.
 */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  }).trim();
}

/**
 * The inverse: plain text as the HTML body of an email.
 *
 * Blank lines become paragraphs and single newlines become breaks, which is how
 * anybody typing into a textarea expects their message to arrive. Escaping is
 * not optional and not a sanitiser's job here — the input is text, so every `<`
 * in it is a literal `<`, and the output is HTML we generated rather than HTML
 * we accepted. That distinction is what lets an auto-response interpolate a
 * customer's own display name without giving them a way to write markup into
 * the mail we send.
 */
export function textToHtml(text: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Line endings first. A browser submits a textarea's breaks as CRLF — the HTML
  // spec normalises them for the form data — so `\n{2,}` below never matched an
  // agent's blank line, and every console reply went out as one paragraph.
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** One-line preview for the inbox list. */
export function preview(text: string, maxLength = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

/**
 * Knowledge base articles.
 *
 * More permissive than the email sanitiser, and deliberately so: articles are
 * authored by agents and imported from Freshdesk, so they carry headings,
 * tables, code samples, screenshots and the occasional embedded video, and a
 * stripped article is a useless article.
 *
 * It is still a sanitiser, not a passthrough. Articles render on the public
 * site under our own domain, so a script that survived here would run for every
 * customer — and imported HTML is only as trustworthy as whoever pasted it into
 * Freshdesk years ago.
 */
const ARTICLE_TAGS = [...ALLOWED_TAGS, 'figure', 'figcaption', 'iframe', 'details', 'summary'];

/**
 * Hosts whose iframes may render. Video embeds are common in support articles
 * and there is no way to keep them without an iframe — but an unrestricted
 * iframe is a full page under someone else's control, so the src is checked
 * against this list and anything else is dropped.
 */
const EMBED_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'www.loom.com',
];

function isAllowedEmbed(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src, 'https://placeholder.invalid');
    return url.protocol === 'https:' && EMBED_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

export function sanitiseArticleHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ARTICLE_TAGS,
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title', 'id'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      iframe: ['src', 'width', 'height', 'title', 'allow', 'allowfullscreen', 'loading'],
      // id carries anchor links and the table of contents; dir and lang matter
      // because articles mix English and Arabic inside one page.
      '*': ['style', 'align', 'dir', 'lang', 'id', 'class'],
      table: ['border', 'cellpadding', 'cellspacing', 'width'],
      td: ['colspan', 'rowspan', 'width', 'height', 'valign'],
      th: ['colspan', 'rowspan', 'width', 'height', 'valign', 'scope'],
      col: ['span', 'width'],
      ol: ['start', 'type'],
    },

    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,

    allowedStyles: {
      '*': {
        color: [/^.*$/],
        'background-color': [/^.*$/],
        'text-align': [/^(left|right|center|justify|start|end)$/],
        'font-size': [/^\d+(?:\.\d+)?(?:px|em|rem|pt|%)$/],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^[a-z- ]+$/],
        margin: [/^[\d\s.a-z%-]+$/],
        padding: [/^[\d\s.a-z%-]+$/],
        border: [/^[\d\s.a-z#()%,-]+$/],
        width: [/^[\d.]+(?:px|em|rem|%)$/],
        height: [/^[\d.]+(?:px|em|rem|%)$/],
        direction: [/^(ltr|rtl)$/],
        // position, z-index and transform stay absent for the same reason as in
        // email: nothing in an article may lift itself out of the article.
      },
    },

    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
      img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }),
    },

    exclusiveFilter: (frame) => frame.tag === 'iframe' && !isAllowedEmbed(frame.attribs.src),

    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title'],
    disallowedTagsMode: 'discard',
  });
}
