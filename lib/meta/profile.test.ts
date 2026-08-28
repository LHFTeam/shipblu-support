import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import {
  downloadAttachment,
  fetchProfile,
  MetaApiError,
  MetaContentTooLargeError,
  profileDisplayName,
  profileFields,
} from './client';
import { explainMetaProfileError, isProfilePermissionRefusal } from './errors';
import { normaliseGender } from './profile';

/**
 * The User Profile API is the only thing that ever tells this system who a
 * Messenger or Instagram customer is — the webhook carries a scoped id and
 * nothing else. Two things are worth pinning down: that the request asks for
 * exactly the fields **Business Asset User Profile Access** grants, and that a
 * refusal caused by the app lacking that feature is recognisable as such.
 *
 * The second matters more than it looks. Graph answers "the app is not approved"
 * and "this person is gone" with the same sentence, and the version of this code
 * that returned null on any failure could not tell them apart — which is how a
 * missing approval hides as a run of private profiles.
 */

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  process.env.META_PAGE_ACCESS_TOKEN = 'token';
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe('profileFields', () => {
  it('asks for the picture on both platforms', () => {
    // The field the feature is most visibly about, and the one the original
    // implementation never requested — so every contact stayed faceless even
    // where the name would have come back.
    expect(profileFields('facebook')).toContain('profile_pic');
    expect(profileFields('instagram')).toContain('profile_pic');
  });

  it("uses each platform's own vocabulary", () => {
    // Messenger splits the name in two and has no handle; Instagram does the
    // opposite. Asking either for the other's fields fails the whole request.
    expect(profileFields('facebook')).toBe('first_name,last_name,name,profile_pic');
    expect(profileFields('instagram')).toBe('name,username,profile_pic');
  });

  it('keeps the separately-gated fields out of the base list', () => {
    // The list that must survive on Business Asset User Profile Access alone.
    // One field we do not hold rights to fails the whole request, taking the
    // name down with it, so this is the list `fetchProfile` falls back to.
    for (const platform of ['facebook', 'instagram'] as const) {
      expect(profileFields(platform)).not.toContain('locale');
      expect(profileFields(platform)).not.toContain('gender');
    }
  });

  it('adds exactly locale and gender when extended', () => {
    expect(profileFields('facebook', { extended: true })).toBe(
      'first_name,last_name,name,profile_pic,locale,gender',
    );
  });

  it('never asks for timezone', () => {
    // A third permission (pages_user_timezone) for a column no screen reads.
    // Requesting it would fail every profile call until it too was approved.
    expect(profileFields('facebook', { extended: true })).not.toContain('timezone');
  });

  it('has no extended list on Instagram', () => {
    /*
      Its User Profile API has neither field, and `pages_user_*` are Page
      permissions. Asking graph.instagram.com for `locale` is a malformed
      request rather than an unapproved one — it would fail forever instead of
      starting to work on approval, and the fallback would hide that by making
      every Instagram lookup cost two calls in perpetuity.
    */
    expect(profileFields('instagram', { extended: true })).toBe('name,username,profile_pic');
  });
});

describe('profileDisplayName', () => {
  it('prefers the whole name Graph gives', () => {
    expect(profileDisplayName({ name: 'Ali Hassan', first_name: 'Ali' })).toBe('Ali Hassan');
  });

  it('assembles one from the halves when there is no whole', () => {
    expect(profileDisplayName({ first_name: 'Ali', last_name: 'Hassan' })).toBe('Ali Hassan');
    expect(profileDisplayName({ first_name: 'Ali' })).toBe('Ali');
    expect(profileDisplayName({ last_name: 'Hassan' })).toBe('Hassan');
  });

  it('reports absence as null rather than as an empty name', () => {
    // A customer with a locked-down profile answers successfully with nothing
    // in it. `''` would be written to `contacts.name` and render as a nameless
    // ticket that nonetheless counts as named, so nothing would ever retry it.
    expect(profileDisplayName({})).toBeNull();
    expect(profileDisplayName({ name: '   ' })).toBeNull();
    expect(profileDisplayName({ first_name: ' ', last_name: ' ' })).toBeNull();
  });
});

describe('fetchProfile', () => {
  /** Graph's answers, in order, one per call. */
  function respondInTurn(...responses: [number, unknown][]) {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const [status, body] = responses[Math.min(call++, responses.length - 1)]!;
      return new Response(JSON.stringify(body), { status });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const REFUSAL = {
    error: { message: 'Unsupported get request.', code: 100, error_subcode: 33 },
  };

  function fieldsOf(fetchMock: ReturnType<typeof respondInTurn>, index: number): string | null {
    const call = fetchMock.mock.calls.at(index) as unknown as [URL | string];
    return new URL(String(call[0])).searchParams.get('fields');
  }

  it('reads the name, handle and picture off a Messenger response', async () => {
    const fetchMock = respondInTurn([
      200,
      {
        first_name: 'Ali',
        last_name: 'Hassan',
        profile_pic: 'https://cdn.example/pic.jpg?token=abc',
      },
    ]);

    const profile = await fetchProfile('facebook', 'psid-1');

    expect(profile).toEqual({
      name: 'Ali Hassan',
      username: null,
      pictureUrl: 'https://cdn.example/pic.jpg?token=abc',
      locale: null,
      gender: null,
      extendedFieldsRefused: false,
    });

    const call = fetchMock.mock.calls.at(0) as unknown as [URL | string];
    expect(new URL(String(call[0])).pathname).toContain('psid-1');
  });

  it('reads the locale and gender when Graph gives them', async () => {
    const fetchMock = respondInTurn([200, { name: 'Ali', locale: 'ar_AR', gender: 'male' }]);

    const profile = await fetchProfile('facebook', 'psid-1');

    // Verbatim, not narrowed. `appLocale` decides what our own column gets, and
    // the region half is only recoverable from here.
    expect(profile.locale).toBe('ar_AR');
    expect(profile.gender).toBe('male');
    expect(profile.extendedFieldsRefused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fieldsOf(fetchMock, 0)).toContain('locale,gender');
  });

  it('keeps the name when only the extra fields are refused', async () => {
    /*
      The regression this whole fallback exists to prevent. Graph rejects the
      *whole* request over one unapproved field, so an app holding Business
      Asset User Profile Access but not pages_user_locale / pages_user_gender
      would learn nothing at all about a customer it has every right to name.
    */
    const fetchMock = respondInTurn([400, REFUSAL], [200, { name: 'Ali Hassan' }]);

    const profile = await fetchProfile('facebook', 'psid-1');

    expect(profile.name).toBe('Ali Hassan');
    expect(profile.locale).toBeNull();
    expect(profile.gender).toBeNull();
    // The flag is the difference between "refused" and "this person set
    // neither" — both leave the columns null and only one is fixed by an
    // approval.
    expect(profile.extendedFieldsRefused).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fieldsOf(fetchMock, 0)).toBe('first_name,last_name,name,profile_pic,locale,gender');
    expect(fieldsOf(fetchMock, 1)).toBe('first_name,last_name,name,profile_pic');
  });

  it('does not claim a refusal when the customer simply set neither', async () => {
    const fetchMock = respondInTurn([200, { name: 'Ali Hassan' }]);

    const profile = await fetchProfile('facebook', 'psid-1');

    expect(profile.extendedFieldsRefused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads an Instagram handle in one call', async () => {
    const fetchMock = respondInTurn([
      200,
      { name: 'Layla', username: 'layla.ships', profile_pic: 'https://cdn/p.jpg' },
    ]);

    const profile = await fetchProfile('instagram', 'igsid-1');
    expect(profile.name).toBe('Layla');
    expect(profile.username).toBe('layla.ships');

    // No extended attempt to spend: Instagram has no such fields.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fieldsOf(fetchMock, 0)).toBe('name,username,profile_pic');
  });

  it('throws when the narrower request is refused too', async () => {
    // Both refused means the feature itself is missing, not the two field
    // permissions — the caller explains that case, so it must still surface.
    const fetchMock = respondInTurn([400, REFUSAL]);

    await expect(fetchProfile('facebook', 'psid-1')).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back on a bare 100, which is what an ungranted field actually returns', async () => {
    /*
      The regression the first version of this shipped with. `(#100) Tried
      accessing nonexisting field (locale) on node type (User)` carries no
      subcode, so `isProfilePermissionRefusal` — which excludes a bare 100 on
      purpose — returns false for it. Keying the fallback on that predicate
      meant the retry never fired for the one case it exists to cover, and the
      name was lost exactly as if the fields had simply been appended.
    */
    const fetchMock = respondInTurn(
      [
        400,
        {
          error: {
            message: '(#100) Tried accessing nonexisting field (locale) on node type (User)',
            code: 100,
          },
        },
      ],
      [200, { name: 'Ali Hassan' }],
    );

    const profile = await fetchProfile('facebook', 'psid-1');

    expect(profile.name).toBe('Ali Hassan');
    expect(profile.extendedFieldsRefused).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a transient failure', async () => {
    // A rate limit belongs to the job's own backoff. Asking again immediately
    // spends the second call on the same refusal and tells nobody anything.
    const fetchMock = respondInTurn([400, { error: { message: 'calls per second', code: 613 } }]);

    await expect(fetchProfile('facebook', 'psid-1')).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('isProfilePermissionRefusal', () => {
  function error(code: number | null, subcode: number | null = null, message = 'nope') {
    return new MetaApiError(message, 400, code, subcode, false);
  }

  it('recognises the refusal an unapproved app actually gets', () => {
    // Code 3 is the one production returns — eleven times over the first day of
    // live lookups — and it went unrecognised, so the log said "refused" and
    // never said why. 100/33 is what Meta documents and has not been seen here;
    // both are kept because either can arrive.
    expect(isProfilePermissionRefusal(error(3))).toBe(true);
    expect(isProfilePermissionRefusal(error(100, 33))).toBe(true);
    expect(isProfilePermissionRefusal(error(200))).toBe(true);
    expect(isProfilePermissionRefusal(error(10))).toBe(true);
  });

  it('does not claim every failure is a missing approval', () => {
    // 100 on its own is a malformed request — a field name we got wrong — and
    // reporting it as "check App Review" would send somebody to the dashboard
    // to look for a feature that is already granted.
    expect(isProfilePermissionRefusal(error(100))).toBe(false);
    expect(isProfilePermissionRefusal(error(190))).toBe(false);
    expect(isProfilePermissionRefusal(error(613))).toBe(false);
    expect(isProfilePermissionRefusal(error(null))).toBe(false);
  });

  it('names the feature on the refusal that carries no hint of it', () => {
    const explained = explainMetaProfileError(
      error(3, null, 'Application does not have the capability to make this API call.'),
      'facebook',
    );

    expect(explained).toContain('Business Asset User Profile Access');
    expect(explained).toContain('code 3');

    // The token type comes first, and it is the whole lesson of 2026-08-27: the
    // message named only App Review, the token was a System User token, and a
    // day went into the wrong dashboard. An explanation that lists one cause
    // for an error with three is how that happens again.
    expect(explained).toContain('Access Token Debugger');
    expect(explained.indexOf('Token Debugger')).toBeLessThan(
      explained.indexOf('Business Asset User Profile Access'),
    );
  });

  it('sends an Instagram linkage refusal to the credential, not to App Review', () => {
    // The Page token cannot resolve an Instagram-scoped id when the account is
    // on Instagram Login. Naming App Review here would be the expensive kind of
    // wrong: the feature could be granted tomorrow and this would still fail.
    const explained = explainMetaProfileError(
      error(
        100,
        null,
        '(#100) The page is not linked to an Instagram account or the linked IG account is ' +
          'not professional account',
      ),
      'instagram',
    );

    expect(explained).toContain('INSTAGRAM_ACCESS_TOKEN');
    expect(explained).toContain('graph.instagram.com');
    expect(explained).not.toContain('App Review for the Meta app');

    // Both fixes, because they are opposites and the log line is read by
    // somebody who may not know which setup the account is on today.
    expect(explained).toContain('Facebook Page');
  });

  it('leaves the same sentence alone on Facebook, where it cannot mean that', () => {
    const explained = explainMetaProfileError(
      error(100, null, 'The page is not linked to an Instagram account'),
      'facebook',
    );

    expect(explained).not.toContain('INSTAGRAM_ACCESS_TOKEN');
  });
});

describe('downloadAttachment size cap', () => {
  function streamOf(chunks: Uint8Array[], headers: Record<string, string> = {}) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers })),
    );
  }

  it('rejects on the declared length without reading the body', async () => {
    streamOf([new Uint8Array(10)], { 'content-length': '5000', 'content-type': 'image/jpeg' });

    await expect(downloadAttachment('https://cdn/p.jpg', { maxBytes: 100 })).rejects.toBeInstanceOf(
      MetaContentTooLargeError,
    );
  });

  it('aborts mid-stream when no length is declared', async () => {
    // The case the guard exists for: a chunked response that only reveals its
    // size as it arrives. Checking `content.length` after `arrayBuffer()` would
    // have allocated all of it before reporting the problem.
    streamOf([new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)], {
      'content-type': 'image/jpeg',
    });

    await expect(downloadAttachment('https://cdn/p.jpg', { maxBytes: 100 })).rejects.toBeInstanceOf(
      MetaContentTooLargeError,
    );
  });

  it('returns a body that fits', async () => {
    streamOf([new Uint8Array(30), new Uint8Array(30)], { 'content-type': 'image/png' });

    const result = await downloadAttachment('https://cdn/p.png', { maxBytes: 100 });
    expect(result.content.length).toBe(60);
    expect(result.contentType).toBe('image/png');
  });

  it('is unbounded when no cap is given', async () => {
    streamOf([new Uint8Array(5000)], { 'content-type': 'image/jpeg' });

    const result = await downloadAttachment('https://cdn/p.jpg');
    expect(result.content.length).toBe(5000);
  });
});

describe('normaliseGender', () => {
  it('accepts the two values Graph documents', () => {
    expect(normaliseGender('male')).toBe('male');
    expect(normaliseGender('female')).toBe('female');
    expect(normaliseGender('Female')).toBe('female');
  });

  it('drops anything else rather than showing an agent a raw token', () => {
    // Meta omits the field for a custom or unset gender, so there is no third
    // value to map — an unexpected string is a surprise, not a datum.
    expect(normaliseGender('unknown')).toBeNull();
    expect(normaliseGender('custom')).toBeNull();
    expect(normaliseGender(null)).toBeNull();
    expect(normaliseGender('  ')).toBeNull();
  });
});
