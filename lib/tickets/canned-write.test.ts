import { describe, expect, it } from 'vitest';
import { cannedBodyColumns } from './canned-write';

describe('cannedBodyColumns', () => {
  // A browser submits a textarea's breaks as CRLF. Kept, the `\r` went out on
  // every WhatsApp and social send, and a seeded response saved once in the
  // console unchanged read to the seed as edited by the team from then on.
  it('stores the text with plain newlines, whatever the textarea submitted', () => {
    const columns = cannedBodyColumns({ ar: 'أولًا\r\n\r\nثانيًا\r\nثالثًا', en: 'One\r\rTwo' });

    expect(columns.bodyTextAr).toBe('أولًا\n\nثانيًا\nثالثًا');
    expect(columns.bodyHtmlAr).toBe('<p>أولًا</p>\n<p>ثانيًا<br>ثالثًا</p>');
    expect(columns.bodyTextEn).toBe('One\n\nTwo');
    expect(columns.bodyText).toBe(columns.bodyTextAr);
  });

  it('leaves an unwritten language empty in both forms, and falls back to the other', () => {
    const columns = cannedBodyColumns({ ar: '', en: 'Only English.' });

    expect(columns).toMatchObject({
      bodyTextAr: '',
      bodyHtmlAr: '',
      bodyTextEn: 'Only English.',
      bodyHtmlEn: '<p>Only English.</p>',
      bodyText: 'Only English.',
      bodyHtml: '<p>Only English.</p>',
    });
  });
});
