/**
 * The chrome and escaping shared by every email this app composes itself.
 *
 * Extracted because there are now two callers — the portal's bilingual account
 * mail and the agent invitation — and the parts they share are exactly the
 * parts that must not drift: the font stack, the base size, the line height and
 * the text colour. A wrapper table for Outlook or a footer added to one copy
 * and not the other is invisible until it is in somebody's inbox, and no test
 * compares two hand-written style strings.
 *
 * Distinct from `lib/html/sanitize.ts`, which exists for the opposite problem.
 * That module makes *attacker-authored* HTML safe to render. This one builds
 * HTML we author, from values that have no business carrying markup at all.
 */

export type EmailBody = { subject: string; textBody: string; htmlBody: string };

/**
 * Minimal HTML: paragraphs, links, a note. Every client renders it the same,
 * which is worth more here than any layout a webmail client might keep.
 *
 * `dir` is not cosmetic — an Arabic body laid out left-to-right is unreadable,
 * and mail clients do not infer direction from the text.
 */
export function emailShell(
  lines: string[],
  { dir = 'ltr', lang = 'en' }: { dir?: 'ltr' | 'rtl'; lang?: string } = {},
): string {
  return [
    `<div dir="${dir}" lang="${lang}" style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#111">`,
    ...lines,
    '</div>',
  ].join('\n');
}

/**
 * Escapes the five characters that matter, quotes included, because these
 * values are interpolated into attributes (`href`) as well as into text.
 *
 * Not `sanitize-html`: a name, an inviter or a URL should not carry markup, so
 * the whole answer is to escape it and let a stray `<` show up as a `<`. The
 * inputs here are typed by an admin rather than by an attacker, which makes
 * this less about defence than about `O'Brien <ops>` not quietly breaking the
 * layout of the message — but the escape is what makes that distinction safe
 * to stop thinking about.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain text for an HTML part, escaped, with its line breaks kept as `<br>`.
 *
 * For a block we compose as text and show verbatim — the side conversation's
 * footer. It differs from `escapeHtml` above in both directions, which is why
 * the two carry different names: newlines become `<br>` rather than collapsing
 * into one run of text, and `'` is left alone, because the output only ever
 * lands in element text and never in an attribute. Lifted from
 * `send-side-email.ts` byte for byte, so the move changed nothing a recipient
 * receives. The footer is a single line today; the `<br>` is what keeps a
 * second line from running into the first.
 *
 * Not `textToHtml` from `lib/html/sanitize.ts` either: that one makes
 * paragraphs out of a message body, and a footer is one block.
 */
export function textToEscapedHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}
