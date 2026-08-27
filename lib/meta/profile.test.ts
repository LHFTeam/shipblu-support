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

function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

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

  it('asks for nothing gated behind a separate permission', () => {
    // locale, timezone and gender each need their own approval. One field we do
    // not hold rights to fails the request, taking the name down with it.
    for (const platform of ['facebook', 'instagram'] as const) {
      expect(profileFields(platform)).not.toContain('locale');
      expect(profileFields(platform)).not.toContain('timezone');
      expect(profileFields(platform)).not.toContain('gender');
    }
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
  it('reads the name, handle and picture off a Messenger response', async () => {
    const fetchMock = respondWith(200, {
      first_name: 'Ali',
      last_name: 'Hassan',
      profile_pic: 'https://cdn.example/pic.jpg?token=abc',
    });

    const profile = await fetchProfile('facebook', 'psid-1');

    expect(profile).toEqual({
      name: 'Ali Hassan',
      username: null,
      pictureUrl: 'https://cdn.example/pic.jpg?token=abc',
    });

    const call = fetchMock.mock.calls.at(0) as unknown as [URL | string];
    const url = new URL(String(call[0]));
    expect(url.pathname).toContain('psid-1');
    expect(url.searchParams.get('fields')).toBe('first_name,last_name,name,profile_pic');
  });

  it('reads an Instagram handle', async () => {
    respondWith(200, { name: 'Layla', username: 'layla.ships', profile_pic: 'https://cdn/p.jpg' });

    const profile = await fetchProfile('instagram', 'igsid-1');
    expect(profile.name).toBe('Layla');
    expect(profile.username).toBe('layla.ships');
  });

  it('throws rather than swallowing a refusal', async () => {
    respondWith(400, {
      error: { message: 'Unsupported get request.', code: 100, error_subcode: 33 },
    });

    await expect(fetchProfile('facebook', 'psid-1')).rejects.toBeInstanceOf(MetaApiError);
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
