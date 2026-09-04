import { describe, expect, it } from 'vitest';
import { articlePath, normaliseArticleHtml, rewriteLegacyArticleLinks } from './format';

/**
 * Every fixture here is markup taken from a real article, shortened only by
 * cutting prose that no rule reads. That matters more than usual: these rules
 * exist because of what four editors and a couple of clipboard pastes actually
 * produced, and a hand-written fixture would test the rule I imagined rather
 * than the input that is in the database.
 */

describe('normaliseArticleHtml', () => {
  it('drops the classes a paste brought with it', () => {
    // The reaching-client-support-team article, pasted out of ChatGPT: the
    // wrapper divs carry Tailwind utilities that this app really does serve, so
    // `items-end` pushes the list to the inline end of a flex column.
    const html =
      '<div class="group/conversation-turn relative flex w-full min-w-0 flex-col agent-turn">' +
      '<div class="min-h-8 text-message flex w-full flex-col items-end gap-2" dir="auto">' +
      '<ul><li dir="ltr">Reach us on live chat.</li></ul></div></div>';

    expect(normaliseArticleHtml(html)).toBe('<ul><li>Reach us on live chat.</li></ul>');
  });

  it('strips inline size and colour, which override the stylesheet', () => {
    const html =
      '<p style="color:rgb(0, 0, 0);font-size:13px;text-align:left">' +
      '<span style="font-size:18px">Fees apply.</span></p>';

    expect(normaliseArticleHtml(html)).toBe('<p>Fees apply.</p>');
  });

  it('turns a body h1 into an h2, which is the level the stylesheet dresses', () => {
    expect(normaliseArticleHtml('<h1 dir="ltr">Packages</h1>')).toBe('<h2>Packages</h2>');
  });

  it('leaves h2 and h3 alone', () => {
    const html = '<h2>Plans</h2><h3>Blu Plan</h3>';
    expect(normaliseArticleHtml(html)).toBe(html);
  });

  it('removes a dir that fights the shell, in both directions', () => {
    expect(normaliseArticleHtml('<p dir="ltr">مقالة جديدة</p>')).toBe('<p>مقالة جديدة</p>');
    expect(normaliseArticleHtml('<p dir="rtl">شحنتي فين؟</p>')).toBe('<p>شحنتي فين؟</p>');
  });

  it('collapses a run of brs to one and drops the ones at a block edge', () => {
    // Sixty of them end the Arabic support-contact article.
    const html = `<ul><li>Saturday to Thursday.${'<br />'.repeat(60)}</li></ul>`;
    expect(normaliseArticleHtml(html)).toBe('<ul><li>Saturday to Thursday.</li></ul>');
  });

  it('keeps a single br between two sentences a run separated', () => {
    // The claims procedure. Deleting this break rather than collapsing it ran
    // "14 days." into "Invalid Orders:" — the run was a paragraph break.
    const html = '<li>within 14 days.<br /><br /><br /><strong>Invalid Orders:</strong></li>';
    expect(normaliseArticleHtml(html)).toBe(
      '<li>within 14 days.<br /><strong>Invalid Orders:</strong></li>',
    );
  });

  it('removes the empty paragraphs an editor leaves behind', () => {
    const html =
      '<p>Done.</p><p style="font-size:18px"><strong><br /><br /></strong></p><p><br /></p>';
    expect(normaliseArticleHtml(html)).toBe('<p>Done.</p>');
  });

  it('unwraps the bold around a screenshot', () => {
    const html = '<strong dir="ltr"><br /><img src="/a.png" class="fr-fic fr-dib" /></strong>';
    expect(normaliseArticleHtml(html)).toBe('<p><img src="/a.png" /></p>');
  });

  it('gives a loose image and a loose sentence a paragraph', () => {
    const html = '<ul><li>Step one.</li></ul><div><img src="/a.png" /></div><div>Then this.</div>';
    expect(normaliseArticleHtml(html)).toBe(
      '<ul><li>Step one.</li></ul><p><img src="/a.png" /></p><p>Then this.</p>',
    );
  });

  it('turns a Freshdesk callout into a blockquote rather than a code block', () => {
    const html =
      '<pre class="fd-callout fd-callout--info" dir="rtl"><span style="font-size:18px">' +
      'يرجى ملاحظة الآتي</span></pre>';

    expect(normaliseArticleHtml(html)).toBe('<blockquote>يرجى ملاحظة الآتي</blockquote>');
  });

  it('unwraps a table that only ever held two screenshots', () => {
    const html =
      '<table class="fr-no-borders" style="width:100%"><tbody><tr>' +
      '<td style="width:33.3333%"><img src="/a.png" /></td>' +
      '<td style="width:66.5738%"><img src="/b.png" /></td>' +
      '</tr></tbody></table>';

    expect(normaliseArticleHtml(html)).toBe(
      '<p><img src="/a.png" /></p><p><img src="/b.png" /></p>',
    );
  });

  it('leaves a table with a header alone', () => {
    const html = '<table><tbody><tr><th>Zone</th><td>Cairo</td></tr></tbody></table>';
    expect(normaliseArticleHtml(html)).toBe(html);
  });

  it('splits a list where a section heading was typed into the previous step', () => {
    // The single-delivery-order guide: one long list of steps whose section
    // headings each ended up inside the step above.
    const html =
      '<ul><li>Choose "Delivery Order".<h1>Order</h1></li>' +
      '<li>Click "From pickup location".</li></ul>';

    expect(normaliseArticleHtml(html)).toBe(
      '<ul><li>Choose "Delivery Order".</li></ul><h2>Order</h2>' +
        '<ul><li>Click "From pickup location".</li></ul>',
    );
  });

  it('lifts the section body out with its heading', () => {
    // The heading sits mid-item with its own prose after it, so the prose comes
    // out too — lifting the heading alone would leave the section under the
    // bullet it was supposed to escape.
    const html =
      '<ul><li>Send orders.<h1>Facing difficulty?</h1><p>Email tech@shipblu.com.</p></li></ul>';

    expect(normaliseArticleHtml(html)).toBe(
      '<ul><li>Send orders.</li></ul><h2>Facing difficulty?</h2><p>Email tech@shipblu.com.</p>',
    );
  });

  it('keeps ol numbering when it splits a numbered list', () => {
    const html = '<ol><li>One.<h1>Next</h1></li><li>Two.</li></ol>';
    expect(normaliseArticleHtml(html)).toBe(
      '<ol><li>One.</li></ol><h2>Next</h2><ol><li>Two.</li></ol>',
    );
  });

  it('lifts a heading out of a list nested two deep', () => {
    const html = '<ul><li>A<ul><li>B<h1>Section</h1></li></ul></li></ul><p>After.</p>';
    expect(normaliseArticleHtml(html)).toBe(
      '<ul><li>A<ul><li>B</li></ul></li></ul><h2>Section</h2><p>After.</p>',
    );
  });

  it('demotes a heading that was wrapped round a paragraph', () => {
    const html = '<ul><li><h1><p dir="ltr">Email: Help@shipblu.com</p></h1></li></ul>';
    expect(normaliseArticleHtml(html)).toBe('<ul><li><p>Email: Help@shipblu.com</p></li></ul>');
  });

  it('closes a heading that swallowed the rest of the article', () => {
    // The Magento article: an h1 opens before "After you are done installing"
    // and does not close until the end of the document, with two more headings
    // inside it. A browser closes it at the next heading; so does this.
    const html =
      '<h1>Configurations</h1><h1 class="font-bold"><p>After you are done installing:</p>' +
      '<h1>Features</h1><ul><li>Orders sent automatically.</li></ul></h1>';

    expect(normaliseArticleHtml(html)).toBe(
      '<h2>Configurations</h2><p>After you are done installing:</p>' +
        '<h2>Features</h2><ul><li>Orders sent automatically.</li></ul>',
    );
  });

  it('takes a screenshot out of a heading', () => {
    const html = '<h1><img src="/a.png" />مستجدات الأنشطة اليومية</h1>';
    expect(normaliseArticleHtml(html)).toBe(
      '<p><img src="/a.png" /></p><h2>مستجدات الأنشطة اليومية</h2>',
    );
  });

  it('unwraps a one-item list that is really a section', () => {
    const html = '<ul><li><h1>Refunds</h1><p>Ask the merchant.</p></li></ul>';
    expect(normaliseArticleHtml(html)).toBe('<h2>Refunds</h2><p>Ask the merchant.</p>');
  });

  it('merges two lists an author separated with a blank line', () => {
    const html = '<ul><li>One.</li></ul><p><br /></p><ul style="font-size:18px"><li>Two.</li></ul>';
    expect(normaliseArticleHtml(html)).toBe('<ul><li>One.</li><li>Two.</li></ul>');
  });

  it('does not merge an ol that is continuing a count', () => {
    // 048.en interleaves a numbered procedure with unnumbered sub-points and
    // resumes the count by hand. Joining these would renumber it from one.
    const html =
      '<ol><li>First.</li></ol><ul><li>Aside.</li></ul><ol start="2"><li>Second.</li></ol>';
    expect(normaliseArticleHtml(html)).toBe(html);
  });

  it('replaces underline, which reads as a link', () => {
    const html = '<p><strong><u>Pickup Confirmation Note</u></strong> :: scan every order.</p>';
    expect(normaliseArticleHtml(html)).toBe(
      '<p><strong>Pickup Confirmation Note</strong> :: scan every order.</p>',
    );
  });

  it('keeps an id, which something outside may already link to', () => {
    const html = '<h1 id="cancellation_feature">Cancellation</h1>';
    expect(normaliseArticleHtml(html)).toBe('<h2 id="cancellation_feature">Cancellation</h2>');
  });

  it('keeps what the sanitiser puts on a link and an image', () => {
    const html =
      '<p><a href="/en/a/packaging-guidelines" rel="noopener noreferrer" target="_blank">Guidelines</a>' +
      '<img src="/a.png" loading="lazy" /></p>';

    expect(normaliseArticleHtml(html)).toBe(
      '<p><a href="/en/a/packaging-guidelines" rel="noopener noreferrer">Guidelines</a>' +
        '<img src="/a.png" loading="lazy" /></p>',
    );
  });

  it('does not join two words that a span separated', () => {
    // `Ship<span>Blu</span>` is one word on the page, and `النق<span>و</span>د`
    // is one word in Arabic. Unwrapping the span must not insert anything.
    expect(normaliseArticleHtml('<p>Ship<span style="color:red">Blu</span></p>')).toBe(
      '<p>ShipBlu</p>',
    );
    expect(normaliseArticleHtml('<p>النق<span dir="ltr">و</span>د</p>')).toBe('<p>النقود</p>');
  });

  it('is idempotent', () => {
    const html =
      '<div class="fr-dib"><h1 dir="ltr">Order</h1><p style="font-size:18px"><br /></p>' +
      '<ul><li dir="rtl">خطوة<h1>القسم</h1></li><li>ثانية</li></ul></div>';

    const once = normaliseArticleHtml(html);
    expect(normaliseArticleHtml(once)).toBe(once);
  });

  it('leaves an already-clean article untouched', () => {
    const html =
      '<p>Our couriers deliver from 10 AM until 7 PM.</p>' +
      '<h2>Delivery days</h2><ul><li>Saturday to Thursday.</li></ul>' +
      '<p><img src="/a.png" loading="lazy" /></p><blockquote>Please note.</blockquote>';

    expect(normaliseArticleHtml(html)).toBe(html);
  });

  it('has nothing to say about an empty body', () => {
    expect(normaliseArticleHtml('')).toBe('');
    expect(normaliseArticleHtml('<p><br /></p>')).toBe('');
  });
});

describe('rewriteLegacyArticleLinks', () => {
  const resolve = (id: string, locale: string | undefined) =>
    id === '154000189336'
      ? {
          locale: locale ?? 'en',
          slug: locale === 'ar' ? 'إرشادات-التعبئة-والتغليف' : 'packaging-guidelines',
        }
      : undefined;

  it('rewrites a portal link, keeping the locale the URL named', () => {
    const html =
      '<a href="https://support.shipblu.com/en/support/solutions/articles/154000189336-packaging-guidelines"' +
      ' rel="noopener noreferrer">Packaging Guidelines</a>';

    expect(rewriteLegacyArticleLinks(html, resolve)).toContain('href="/en/a/packaging-guidelines"');
  });

  it('rewrites the Arabic side to the Arabic article', () => {
    const html =
      '<a href="https://support.shipblu.com/ar/support/solutions/articles/154000189336-%D8%A5">إرشادات</a>';

    expect(rewriteLegacyArticleLinks(html, resolve)).toContain(
      'href="/ar/a/إرشادات-التعبئة-والتغليف"',
    );
  });

  it('rewrites an agent-console link, whose locale is in its query string', () => {
    // A customer clicking one of these gets a Freshdesk login screen.
    const html =
      '<a href="https://shipblu72137318794432249.freshdesk.com/a/solutions/articles/154000189336' +
      '?lang=ar&amp;portalId=154000090201">الجدول</a>';

    expect(rewriteLegacyArticleLinks(html, resolve)).toContain(
      'href="/ar/a/إرشادات-التعبئة-والتغليف"',
    );
  });

  it('leaves a link alone when the article is not in the knowledge base', () => {
    const html =
      '<a href="https://support.shipblu.com/en/support/solutions/articles/9999">Gone</a>';
    expect(rewriteLegacyArticleLinks(html, resolve)).toBe(html);
  });

  it('does not touch a link to anywhere else', () => {
    const html = '<a href="https://apps.shopify.com/shipblu">Shopify</a>';
    expect(rewriteLegacyArticleLinks(html, resolve)).toBe(html);
  });
});

describe('articlePath', () => {
  it('is relative, so it resolves on every host this app answers on', () => {
    expect(articlePath('ar', 'شحنتي-فين؟')).toBe('/ar/a/شحنتي-فين؟');
  });
});
