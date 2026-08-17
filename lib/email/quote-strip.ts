/**
 * Removing quoted history and signatures from inbound replies.
 *
 * Without this, every reply in a thread restates the entire conversation and the
 * ticket view becomes unreadable after three exchanges. There is no standard for
 * how clients mark quoted text, so this matches the markers the major ones
 * actually emit, and takes the *earliest* match so a nested quote cannot smuggle
 * history through.
 *
 * Stripping is never destructive: callers store the original in
 * `messages.raw_body`, so a marker we get wrong costs a click to expand rather
 * than losing what the customer wrote.
 */

/**
 * Included in every outbound email. When the customer replies underneath it,
 * this becomes the most reliable marker available — it is the one we control,
 * so it is checked first and matches regardless of client or language.
 */
export const REPLY_ABOVE_MARKER = '##- Please type your reply above this line -##';

export type StripResult = {
  /** What the customer actually wrote this time. */
  visible: string;
  /** Everything removed, or null if nothing matched. */
  quoted: string | null;
  /** Which rule fired, for debugging a thread that stripped wrongly. */
  matchedBy: string | null;
};

type Marker = { name: string; pattern: RegExp };

/**
 * Ordered by reliability, but all are evaluated — the earliest position in the
 * body wins, not the first rule in this list.
 */
const TEXT_MARKERS: Marker[] = [
  { name: 'shipblu_marker', pattern: /^.*##-\s*Please type your reply above this line\s*-##.*$/m },

  // Outlook, English and localised variants.
  { name: 'original_message', pattern: /^\s*-{2,}\s*Original Message\s*-{2,}/im },
  { name: 'forwarded_message', pattern: /^\s*-{2,}\s*Forwarded message\s*-{2,}/im },
  // Outlook's horizontal rule between reply and quote.
  { name: 'outlook_divider', pattern: /^\s*_{10,}\s*$/m },

  // Gmail and Apple Mail attribution. Allowed to span lines because long
  // addresses wrap, but bounded so it cannot run away through the whole body.
  { name: 'on_wrote', pattern: /^On\s[\s\S]{0,300}?\swrote:\s*$/m },
  // Arabic equivalent ("On <date>, <name> wrote:").
  { name: 'on_wrote_ar', pattern: /^(في|بتاريخ)\s[\s\S]{0,300}?\sكتب:\s*$/m },

  // Outlook quotes the original as a header block rather than an attribution.
  {
    name: 'header_block',
    pattern: /^\s*(From|De|Von|Da|من):\s*.+$\n^\s*(Sent|Date|Enviado|Gesendet|التاريخ|مرسل):/im,
  },

  // A run of quoted lines that continues to the end of the message.
  { name: 'quote_chevrons', pattern: /^>[^\n]*(?:\n>[^\n]*)*\s*$/m },
];

/** RFC 3676 signature delimiter: a line containing exactly "-- ". */
const SIGNATURE_PATTERN = /^-- ?$/m;

function earliestMatch(text: string, markers: Marker[]): { index: number; name: string } | null {
  let best: { index: number; name: string } | null = null;

  for (const marker of markers) {
    const match = marker.pattern.exec(text);
    if (match && (best === null || match.index < best.index)) {
      best = { index: match.index, name: marker.name };
    }
  }

  return best;
}

export function stripQuotedText(text: string): StripResult {
  if (!text.trim()) return { visible: text, quoted: null, matchedBy: null };

  const match = earliestMatch(text, TEXT_MARKERS);

  let visible = text;
  let quoted: string | null = null;
  let matchedBy: string | null = null;

  if (match) {
    const candidate = text.slice(0, match.index);
    // Guard against a marker at position 0 (e.g. a reply typed *below* the
    // quote, or an attribution as the first line). Stripping there would leave
    // an empty message, which is worse than leaving the quote in.
    if (candidate.trim()) {
      visible = candidate;
      quoted = text.slice(match.index);
      matchedBy = match.name;
    }
  }

  const signature = SIGNATURE_PATTERN.exec(visible);
  if (signature && visible.slice(0, signature.index).trim()) {
    quoted = visible.slice(signature.index) + (quoted ?? '');
    visible = visible.slice(0, signature.index);
    matchedBy = matchedBy ? `${matchedBy}+signature` : 'signature';
  }

  return { visible: visible.trimEnd(), quoted, matchedBy };
}

/**
 * HTML markers. Matched with regex rather than a DOM parse: we only need the
 * offset of the first quote container, and every option here is an opening tag
 * that clients emit verbatim. Truncating there can leave unbalanced tags, which
 * is fine because the result is sanitised before it is ever rendered.
 */
const HTML_MARKERS: Marker[] = [
  { name: 'shipblu_marker', pattern: /##-\s*Please type your reply above this line\s*-##/i },

  { name: 'gmail_quote', pattern: /<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>/i },
  { name: 'gmail_attr', pattern: /<div[^>]*class="[^"]*gmail_attr[^"]*"[^>]*>/i },

  // Outlook web and desktop.
  { name: 'outlook_reply', pattern: /<div[^>]*id="?divRplyFwdMsg"?[^>]*>/i },
  { name: 'outlook_appendonsend', pattern: /<div[^>]*id="?appendonsend"?[^>]*>/i },
  { name: 'outlook_src_body', pattern: /<div[^>]*id="?OLK_SRC_BODY_SECTION"?[^>]*>/i },
  {
    name: 'outlook_hr',
    pattern: /<hr[^>]*(?:id="?stopSpelling"?|style="[^"]*display:inline-block)[^>]*>/i,
  },

  // Apple Mail and most standards-compliant clients.
  { name: 'blockquote_cite', pattern: /<blockquote[^>]*type="?cite"?[^>]*>/i },

  { name: 'yahoo_quote', pattern: /<div[^>]*class="[^"]*yahoo_quoted[^"]*"[^>]*>/i },
];

export function stripQuotedHtml(html: string): StripResult {
  if (!html.trim()) return { visible: html, quoted: null, matchedBy: null };

  const match = earliestMatch(html, HTML_MARKERS);
  if (!match) return { visible: html, quoted: null, matchedBy: null };

  const candidate = html.slice(0, match.index);

  // Same guard as the text path: if everything before the marker is markup with
  // no actual words, the customer replied below the quote and stripping would
  // destroy the message.
  if (!hasVisibleText(candidate)) {
    return { visible: html, quoted: null, matchedBy: null };
  }

  return {
    visible: candidate,
    quoted: html.slice(match.index),
    matchedBy: match.name,
  };
}

/** True if the HTML contains any non-whitespace text outside of tags. */
function hasVisibleText(html: string): boolean {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim().length > 0
  );
}
