import { describe, expect, it } from 'vitest';
import {
  freshdeskReferences,
  isFreshdeskAddress,
  restoreRefusal,
  saveRefusal,
} from './freshdesk-refs';

const BUCKET_IMAGE =
  'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/154012/original/a.png';
const PORTAL_ARTICLE =
  'https://support.shipblu.com/en/support/solutions/articles/154000189336-packaging-guidelines';

describe('isFreshdeskAddress', () => {
  it.each([
    ['the portal, by an article', PORTAL_ARTICLE],
    [
      'the portal, by a folder',
      'https://support.shipblu.com/en/support/solutions/folders/154000100',
    ],
    ['the portal home', 'https://support.shipblu.com/support/home'],
    ['the portal ticket form', 'https://support.shipblu.com/support/tickets/new'],
    [
      'the agent console',
      'https://shipblu72137318794432249.freshdesk.com/a/solutions/articles/154000206447?lang=ar',
    ],
    ['a portal path with no host', '/en/support/solutions/articles/154000189336'],
    ['a portal path with no scheme', '//support.shipblu.com/support/home'],
    // Served from the portal's own host while Freshdesk held it, so no
    // Freshworks domain is named.
    ['an attachment on the portal', 'https://support.shipblu.com/helpdesk/attachments/48012345'],
    ['the portal forums', 'https://support.shipblu.com/en/support/discussions/topics/154000001'],
    ["Freshdesk's bucket, path-style", BUCKET_IMAGE],
    ["Freshdesk's bucket, virtual-hosted", 'https://cdn.freshdesk.com.s3.amazonaws.com/x.png'],
    ['a Freshworks CDN, over http', 'http://assets.fw-cdn.com/logo.png'],
    ['Freshchat', 'https://wchat.freshchat.com/js/widget.js'],
    ['a Freshdesk mailbox', 'mailto:support@shipblu.freshdesk.com?subject=Help'],
    ['a Freshdesk mailbox among others', 'mailto:support@shipblu.freshdesk.com,ops@shipblu.com'],
  ])('is true for %s', (_, address) => {
    expect(isFreshdeskAddress(address)).toBe(true);
  });

  it.each([
    [
      'an article here, on the portal host, ours since 2026-11-11',
      'https://support.shipblu.com/en/a/x',
    ],
    ['an article here, relative', '/ar/a/شحنتي-فين؟'],
    ['a picture we hold', '/api/kb/images/0b5f8c1e-2a4b-4c3d-9e8f-1a2b3c4d5e6f'],
    ['a fragment', '#step-2'],
    ['our own mailbox', 'mailto:support@shipblu.com'],
    // Another company's own portal does not break when ours closes.
    ['somebody else’s portal', 'https://help.carrier.example/en/support/solutions/articles/1'],
    ['a page that only mentions Freshdesk', 'https://blog.example/why-we-left-freshdesk'],
    ['another bucket on S3', 'https://s3.amazonaws.com/other-bucket/cdn.freshdesk.com/a.png'],
    ['a phone number', 'tel:+20100000000'],
    ['a mailbox with a malformed escape', 'mailto:ops%zz@shipblu.com'],
  ])('is false for %s', (_, address) => {
    expect(isFreshdeskAddress(address)).toBe(false);
  });
});

describe('freshdeskReferences', () => {
  it('reads links and pictures from stored HTML, entities decoded', () => {
    const html =
      '<p><a href="https://shipblu1.freshdesk.com/a/solutions/articles/1?lang=ar&amp;portalId=2">' +
      'الجدول</a> <a href="/en/a/packaging-guidelines">here</a></p>' +
      `<p><img src="${BUCKET_IMAGE}" loading="lazy" /></p>` +
      '<p><img src="/api/kb/images/0b5f8c1e-2a4b-4c3d-9e8f-1a2b3c4d5e6f" /></p>';

    expect(freshdeskReferences(html)).toEqual([
      {
        kind: 'link',
        address: 'https://shipblu1.freshdesk.com/a/solutions/articles/1?lang=ar&portalId=2',
        home: 'freshworks',
      },
      { kind: 'image', address: BUCKET_IMAGE, home: 'freshworks' },
    ]);
  });

  // The portal's hostname has been this app since 2026-11-11, so an address
  // there no longer breaks *with* Freshdesk; it already has. Said apart, so the
  // refusal does not tell an editor it still works.
  it('says which addresses are on the portal and which on Freshworks', () => {
    const html =
      '<p><a href="https://support.shipblu.com/support/home">a</a>' +
      '<a href="/ar/support/tickets/new">b</a>' +
      '<a href="mailto:support@shipblu.freshdesk.com">c</a></p>' +
      '<p><img src="https://support.shipblu.com/helpdesk/attachments/48012345" /></p>';

    expect(freshdeskReferences(html).map(({ address, home }) => [address, home])).toEqual([
      ['https://support.shipblu.com/support/home', 'portal'],
      ['/ar/support/tickets/new', 'portal'],
      ['mailto:support@shipblu.freshdesk.com', 'freshworks'],
      ['https://support.shipblu.com/helpdesk/attachments/48012345', 'portal'],
    ]);
  });

  it('reads nothing out of the words between tags', () => {
    expect(
      freshdeskReferences('<p>The old portal was support.shipblu.com/support/home.</p>'),
    ).toEqual([]);
  });
});

describe('saveRefusal', () => {
  it('refuses a new article that links to Freshdesk, naming the address', () => {
    const html = `<p><a href="${PORTAL_ARTICLE.replace('154000189336', '154000000001')}">x</a></p>`;

    expect(saveRefusal(html, null, 'ar')).toBe(
      'The article has a link to Freshdesk article 154000000001, which has no published article here ' +
        '(https://support.shipblu.com/en/support/solutions/articles/154000000001-packaging-guidelines). ' +
        'Point it at an article on this help centre (/<language>/a/<slug>) or remove it, then save.',
    );
  });

  // Not "goes away once Freshdesk is disconnected": that hostname has been this
  // app since 2026-11-11, and proxy.ts answers a page of the portal with the
  // stand-in `freshdeskPortalRedirect` names, so the refusal offers that page.
  it('refuses a link to a page of the portal, naming where it lands here', () => {
    expect(
      saveRefusal(
        '<p><a href="https://support.shipblu.com/support/tickets/new">x</a></p>',
        null,
        'ar',
      ),
    ).toBe(
      "The article has a link to a page of Freshdesk's old portal, which now only redirects to /ar#contact here " +
        '(https://support.shipblu.com/support/tickets/new). ' +
        'Point it at /ar#contact or remove it, then save.',
    );
    expect(saveRefusal('<p><a href="/en/support/search?term=cod">x</a></p>', null, 'ar')).toBe(
      "The article has a link to a page of Freshdesk's old portal, which now only redirects to /en/search?q=cod here " +
        '(/en/support/search?term=cod). ' +
        'Point it at /en/search?q=cod or remove it, then save.',
    );
  });

  // The legacy route sends a folder or a category to its own page where the
  // import kept its id (#515, #520), which takes a lookup the refusal does not
  // make, so it names the kind of page to point at instead.
  it('refuses a folder or a category, offering its page here', () => {
    expect(
      saveRefusal(
        '<p><a href="https://support.shipblu.com/en/support/solutions/folders/154000100">x</a></p>',
        null,
        'ar',
      ),
    ).toBe(
      "The article has a link to Freshdesk folder 154000100, which now only redirects to that folder's page here, if it was imported " +
        '(https://support.shipblu.com/en/support/solutions/folders/154000100). ' +
        "Point it at the folder's page on this help centre (/<language>/c/<category>/<folder>) or remove it, then save.",
    );
    expect(
      saveRefusal(
        '<p><a href="https://support.shipblu.com/ar/support/solutions/154000297679-x">x</a></p>',
        null,
        'ar',
      ),
    ).toContain(
      "a link to Freshdesk category 154000297679, which now only redirects to that category's page here",
    );
  });

  it('refuses a forum of the portal, which nothing here answers', () => {
    expect(
      saveRefusal(
        '<p><a href="https://support.shipblu.com/en/support/discussions/topics/1">x</a></p>',
        null,
        'ar',
      ),
    ).toContain("a link to Freshdesk's old portal, which nothing here answers");
  });

  // A page of the portal named with no language is offered in the article's,
  // the reader it is for; a language in the link still wins.
  it("offers a portal page in the article's language unless the link names one", () => {
    const bare = '<p><a href="https://support.shipblu.com/support/tickets/new">x</a></p>';
    expect(saveRefusal(bare, null, 'en')).toContain('Point it at /en#contact');
    expect(saveRefusal('<p><a href="/ar/support/home">x</a></p>', null, 'en')).toContain(
      'Point it at /ar or remove it',
    );
    expect(saveRefusal('<p><a href="/support/home?url_locale=ar">x</a></p>', null, 'en')).toContain(
      'Point it at /ar or remove it',
    );
    // An empty or unknown url_locale names no language of ours, so the
    // article's wins rather than the default.
    for (const asked of ['', 'fr', 'en-XX-1']) {
      expect(
        saveRefusal(`<p><a href="/support/home?url_locale=${asked}">x</a></p>`, null, 'en'),
      ).toContain('Point it at /en or remove it');
    }
  });

  // Not "goes away once": the merchant dashboard's links to an older account,
  // shipblu.freshdesk.com, 404 already, and nothing here can tell the two apart.
  it('says a link on Freshdesk itself is being disconnected', () => {
    const live = 'https://shipblu72137318794432249.freshdesk.com/support/home';
    expect(saveRefusal(`<p><a href="${live}">x</a></p>`, null, 'ar')).toBe(
      `The article has a link to Freshdesk, which is being disconnected (${live}). ` +
        'Point it at an article on this help centre (/<language>/a/<slug>) or remove it, then save.',
    );
  });

  it('refuses a picture from the portal, which no longer loads', () => {
    const picture = 'https://support.shipblu.com/helpdesk/attachments/48012345';
    expect(saveRefusal(`<p><img src="${picture}" /></p>`, null, 'ar')).toBe(
      `The article shows a picture from Freshdesk's old portal, which no longer loads (${picture}). Remove it, or add the picture again with Insert picture, then save.`,
    );
  });

  it('refuses a picture Freshdesk serves', () => {
    expect(saveRefusal(`<p><img src="${BUCKET_IMAGE}" /></p>`, '<p>Before.</p>', 'ar')).toBe(
      `The article shows a picture from Freshdesk, which stops loading once Freshdesk is disconnected (${BUCKET_IMAGE}). Remove it, or add the picture again with Insert picture, then save.`,
    );
  });

  // An article waiting for `rehost_kb_images`, or one whose picture it could
  // not copy, can still be edited: the save adds nothing of Freshdesk's.
  it('lets a save keep what the stored article already carries', () => {
    const stored = `<p>Step one</p><p><img src="${BUCKET_IMAGE}" /></p>`;
    const edited = `<p>Step one, edited</p><p><img src="${BUCKET_IMAGE}" /></p>`;

    expect(saveRefusal(edited, stored, 'ar')).toBeNull();
    // A link to the same address is a different thing to have added.
    expect(saveRefusal(`${edited}<p><a href="${BUCKET_IMAGE}">a</a></p>`, stored, 'ar')).toContain(
      'a link to Freshdesk',
    );
  });

  it('passes a body with nothing of Freshdesk in it', () => {
    expect(saveRefusal('<p><a href="/en/a/packaging-guidelines">x</a></p>', null, 'ar')).toBeNull();
  });
});

describe('restoreRefusal', () => {
  it('refuses a version that would bring Freshdesk back, and says what to do instead', () => {
    expect(restoreRefusal(`<p><img src="${BUCKET_IMAGE}" /></p>`, '<p>Now.</p>', 'ar')).toBe(
      `That version shows a picture from Freshdesk, which stops loading once Freshdesk is disconnected (${BUCKET_IMAGE}), so restoring it would put Freshdesk back on the help centre. Restore another version, or edit the article instead.`,
    );
  });

  it('says a portal address is the old portal, not Freshdesk, coming back', () => {
    const picture = 'https://support.shipblu.com/helpdesk/attachments/48012345';
    expect(restoreRefusal(`<p><img src="${picture}" /></p>`, '<p>Now.</p>', 'ar')).toBe(
      `That version shows a picture from Freshdesk's old portal, which no longer loads (${picture}), so restoring it would put an address of Freshdesk's old portal back on the help centre. Restore another version, or edit the article instead.`,
    );
  });

  it('restores a version holding only what the article already holds', () => {
    const html = `<p><img src="${BUCKET_IMAGE}" /></p>`;
    expect(restoreRefusal(`<p>Older words.</p>${html}`, html, 'ar')).toBeNull();
  });
});
