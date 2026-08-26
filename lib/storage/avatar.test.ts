import { describe, expect, it } from 'vitest';
import { buildAvatarPath, isStorableAvatarType } from './index';

/**
 * The avatar object key is the one thing standing between "one picture per
 * contact, overwritten" and a bucket that accumulates a copy of every profile
 * picture a customer has ever had — `contacts.avatar_path` only ever remembers
 * the newest, so anything else written is unreferenced bytes nothing deletes.
 */
describe('buildAvatarPath', () => {
  it('is stable across a change of image format', () => {
    // Meta's CDN re-encodes. Deriving the extension from the content type is the
    // obvious implementation and it strands the previous object every time the
    // format moves — up to one orphan per accepted type, per contact.
    const contactId = '11111111-2222-3333-4444-555555555555';
    expect(buildAvatarPath(contactId)).toBe(`contacts/${contactId}/avatar`);
  });

  it('derives the whole key from the id we generated', () => {
    // Never from the remote URL: Meta's link is a query-string blob, and a path
    // segment taken from a URL is a path segment somebody else chose.
    expect(buildAvatarPath('abc')).toBe('contacts/abc/avatar');
  });
});

describe('isStorableAvatarType', () => {
  it('accepts the image types Meta actually serves', () => {
    expect(isStorableAvatarType('image/jpeg')).toBe(true);
    expect(isStorableAvatarType('image/png')).toBe(true);
    expect(isStorableAvatarType('image/webp')).toBe(true);
    expect(isStorableAvatarType('image/gif')).toBe(true);
  });

  it('reads a content type that carries parameters', () => {
    // A CDN sending `image/jpeg; charset=binary` is still sending a JPEG, and
    // rejecting it would silently cost the picture.
    expect(isStorableAvatarType('image/jpeg; charset=binary')).toBe(true);
    expect(isStorableAvatarType('IMAGE/PNG')).toBe(true);
  });

  it('refuses anything that is not one of them', () => {
    // SVG in particular: it is an image to a browser and a script host to an
    // attacker, and this one is served back to agents.
    expect(isStorableAvatarType('image/svg+xml')).toBe(false);
    expect(isStorableAvatarType('text/html')).toBe(false);
    expect(isStorableAvatarType('application/octet-stream')).toBe(false);
  });
});
