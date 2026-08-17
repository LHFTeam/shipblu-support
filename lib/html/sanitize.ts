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

/** One-line preview for the inbox list. */
export function preview(text: string, maxLength = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}
