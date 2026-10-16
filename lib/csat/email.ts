import { emailShell, escapeHtml } from '@/lib/email/html';
import { direction } from '@/lib/kb/locale';
import { ratingLabels, ratingUrl, type Wording, type WordingLocale } from './wording';

/**
 * The survey as an email: the first line, the second, the question, and the
 * five ratings as links that land on the page with the choice made.
 *
 * The links name the rating; the page records nothing until the customer taps
 * its button. Mail scanners fetch every link in a mail before the person sees
 * it, so a page that recorded on the GET would file a five-star rating from
 * Microsoft — the tap count is the same as the page always had (open, tap),
 * the customer just arrives with their choice made.
 *
 * Minimal HTML through `emailShell`, for the reason it gives: every client
 * renders it the same. The links are bordered anchors rather than buttons,
 * which webmail clients strip the styling from.
 */
export function surveyEmail(
  wording: Wording,
  locale: WordingLocale,
  url: string,
): { text: string; html: string } {
  const labels = ratingLabels(locale);
  const dir = direction(locale);

  const text = [
    wording.intro,
    wording.subtitle,
    '',
    wording.question,
    ...labels.map((label, index) => `${label}: ${ratingUrl(url, index + 1)}`),
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
    .trim();

  const links = labels
    .map(
      (label, index) =>
        `<a href="${escapeHtml(ratingUrl(url, index + 1))}" style="display:inline-block;margin:0 6px 8px 0;padding:8px 14px;border:1px solid #cbd5e1;border-radius:6px;color:#111;text-decoration:none">${escapeHtml(label)}</a>`,
    )
    .join('\n');

  const html = emailShell(
    [
      wording.intro ? `<p>${escapeHtml(wording.intro)}</p>` : '',
      wording.subtitle ? `<p>${escapeHtml(wording.subtitle)}</p>` : '',
      `<p style="font-weight:600">${escapeHtml(wording.question)}</p>`,
      `<p>${links}</p>`,
    ].filter(Boolean),
    { dir, lang: locale },
  );

  return { text, html };
}
