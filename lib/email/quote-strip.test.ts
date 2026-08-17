import { describe, expect, it } from 'vitest';
import { REPLY_ABOVE_MARKER, stripQuotedHtml, stripQuotedText } from './quote-strip';

describe('stripQuotedText', () => {
  it('strips a Gmail-style attribution and everything after it', () => {
    const body = [
      'It still has not arrived.',
      '',
      'On Mon, 17 Aug 2026 at 10:04, ShipBlu Support <support@shipblu.com> wrote:',
      '> Thanks for getting in touch, we are checking now.',
      '> — ShipBlu',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('It still has not arrived.');
    expect(result.matchedBy).toBe('on_wrote');
    expect(result.quoted).toContain('Thanks for getting in touch');
  });

  it('strips an Outlook "Original Message" block', () => {
    const body = [
      'Any update?',
      '',
      '-----Original Message-----',
      'From: support@shipblu.com',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('Any update?');
    expect(result.matchedBy).toBe('original_message');
  });

  it('strips an Outlook header block', () => {
    const body = [
      'Please expedite.',
      '',
      'From: ShipBlu Support <support@shipblu.com>',
      'Sent: Monday, 17 August 2026 10:04',
      'To: Ali',
      'Subject: Re: parcel',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('Please expedite.');
    expect(result.matchedBy).toBe('header_block');
  });

  it('strips an Outlook underscore divider', () => {
    const body = [
      'Confirmed, thanks.',
      '',
      '________________________________',
      'From: support',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('Confirmed, thanks.');
    expect(result.matchedBy).toBe('outlook_divider');
  });

  it('strips an Arabic attribution', () => {
    const body = [
      'لم تصل الشحنة بعد.',
      '',
      'في الاثنين، 17 أغسطس 2026، ShipBlu Support كتب:',
      '> شكرا لتواصلك معنا',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('لم تصل الشحنة بعد.');
    expect(result.matchedBy).toBe('on_wrote_ar');
  });

  it('prefers our own marker and takes the earliest match', () => {
    const body = [
      'Here is my reply.',
      '',
      REPLY_ABOVE_MARKER,
      '',
      'On Mon, 17 Aug 2026, ShipBlu Support <support@shipblu.com> wrote:',
      '> previous message',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('Here is my reply.');
    expect(result.matchedBy).toBe('shipblu_marker');
  });

  it('strips an RFC 3676 signature', () => {
    const body = ['Thanks for the help!', '', '-- ', 'Ali Nasser', 'ShipBlu'].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('Thanks for the help!');
    expect(result.matchedBy).toBe('signature');
    expect(result.quoted).toContain('Ali Nasser');
  });

  it('strips both a quote and a signature, keeping both in quoted', () => {
    const body = [
      'Still waiting.',
      '',
      '-- ',
      'Ali',
      '',
      '-----Original Message-----',
      'From: support',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible.trim()).toBe('Still waiting.');
    expect(result.quoted).toContain('Ali');
    expect(result.quoted).toContain('Original Message');
  });

  it('does not strip when the reply is written below the quote', () => {
    // Bottom-posting: the marker is at position 0, so stripping would leave an
    // empty message. Leaving the quote in is much better than losing the reply.
    const body = [
      'On Mon, 17 Aug 2026, ShipBlu Support <support@shipblu.com> wrote:',
      '> Can you confirm the address?',
      '',
      'Yes, 12 Nile St.',
    ].join('\n');

    const result = stripQuotedText(body);
    expect(result.visible).toContain('Yes, 12 Nile St.');
    expect(result.matchedBy).toBeNull();
  });

  it('leaves an ordinary message untouched', () => {
    const body = 'My parcel says delivered but I never received it. Order 12345.';
    const result = stripQuotedText(body);
    expect(result.visible).toBe(body);
    expect(result.quoted).toBeNull();
    expect(result.matchedBy).toBeNull();
  });

  it('does not treat a bare "--" as a signature delimiter mid-sentence', () => {
    const body = 'The tracking page says "in transit" -- but it has not moved in a week.';
    const result = stripQuotedText(body);
    expect(result.visible).toBe(body);
  });

  it('handles an empty body', () => {
    expect(stripQuotedText('').visible).toBe('');
    expect(stripQuotedText('   ').quoted).toBeNull();
  });
});

describe('stripQuotedHtml', () => {
  it('strips a Gmail quote container', () => {
    const html =
      '<div dir="ltr">It still has not arrived.</div>' +
      '<div class="gmail_quote"><blockquote>old stuff</blockquote></div>';

    const result = stripQuotedHtml(html);
    expect(result.visible).toContain('It still has not arrived.');
    expect(result.visible).not.toContain('old stuff');
    expect(result.matchedBy).toBe('gmail_quote');
  });

  it('strips an Apple Mail cited blockquote', () => {
    const html = '<p>Any update?</p><blockquote type="cite"><p>previous</p></blockquote>';

    const result = stripQuotedHtml(html);
    expect(result.visible).toContain('Any update?');
    expect(result.visible).not.toContain('previous');
    expect(result.matchedBy).toBe('blockquote_cite');
  });

  it('strips an Outlook reply container', () => {
    const html = '<div>Please expedite.</div><div id="divRplyFwdMsg"><p>original</p></div>';

    const result = stripQuotedHtml(html);
    expect(result.visible).toContain('Please expedite.');
    expect(result.matchedBy).toBe('outlook_reply');
  });

  it('does not strip when nothing precedes the quote but markup', () => {
    // Bottom-posted HTML reply: everything before the quote is empty tags.
    const html = '<div></div><blockquote type="cite"><p>the whole conversation</p></blockquote>';

    const result = stripQuotedHtml(html);
    expect(result.visible).toBe(html);
    expect(result.matchedBy).toBeNull();
  });

  it('ignores text hidden in style and script when judging emptiness', () => {
    const html = '<style>.x{color:red}</style><blockquote type="cite"><p>quoted</p></blockquote>';

    const result = stripQuotedHtml(html);
    expect(result.visible).toBe(html);
    expect(result.matchedBy).toBeNull();
  });

  it('leaves an ordinary HTML message untouched', () => {
    const html = '<div dir="ltr">Where is my parcel?</div>';
    expect(stripQuotedHtml(html).visible).toBe(html);
    expect(stripQuotedHtml(html).quoted).toBeNull();
  });
});
