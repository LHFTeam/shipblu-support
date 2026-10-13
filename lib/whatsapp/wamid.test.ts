import { describe, expect, it } from 'vitest';
import { wamidKey } from './wamid';

/*
  Built rather than pasted, so no customer's phone number is in the repo. The
  builder writes the bytes production's wamids carry — re-encoding a real pair
  through it reproduced both strings exactly — and the two literals below are
  its output, pinned so a change to the builder cannot quietly change what is
  being tested.
*/
function wamid({
  user,
  server,
  fromMe,
  id,
}: {
  user: string;
  server: number;
  fromMe: boolean;
  id: string;
}): string {
  const ascii = (text: string) => [...Buffer.from(text)];
  const bytes = [
    0x1c, // field 1, struct: the chat
    0x18, // its field 1, binary: the user
    user.length,
    ...ascii(user),
    0x15, // its field 2, i32: the server, zigzag
    server * 2,
    0x00, // end of the chat
    fromMe ? 0x11 : 0x12, // field 2, bool
    0x18, // field 3, binary: the id
    id.length,
    ...ascii(id),
    0x00,
  ];
  return `wamid.${Buffer.from(bytes).toString('base64')}`;
}

const ID = '3EB0AAAA11112222BBBB33';

// The customer's copy of our reply, as their reaction names it…
const BY_PHONE = 'wamid.HBgMMjAxMDAwMDAwMDAxFQIAERgWM0VCMEFBQUExMTExMjIyMkJCQkIzMwA=';
// …and the business app's echo of the same reply, as we stored it.
const BY_ECHO = 'wamid.HBgTRUcuMTAwMDAwMDAwMDAwMDAwMRUUABEYFjNFQjBBQUFBMTExMTIyMjJCQkJCMzMA';

describe('wamidKey', () => {
  it('builds the same strings production carries', () => {
    expect(wamid({ user: '201000000001', server: 1, fromMe: true, id: ID })).toBe(BY_PHONE);
    expect(wamid({ user: 'EG.1000000000000001', server: 10, fromMe: true, id: ID })).toBe(BY_ECHO);
  });

  it('gives two copies of one message the same key', () => {
    // The whole reason this exists: as strings these differ, and a customer's
    // reaction to a reply typed on the phone found nothing.
    expect(BY_PHONE).not.toBe(BY_ECHO);
    expect(wamidKey(BY_PHONE)).toBe(`out:${ID}`);
    expect(wamidKey(BY_ECHO)).toBe(`out:${ID}`);
  });

  it('keeps the two sides apart when their ids collide', () => {
    const ours = wamid({ user: '201000000001', server: 1, fromMe: true, id: ID });
    const theirs = wamid({ user: '201000000001', server: 1, fromMe: false, id: ID });

    expect(wamidKey(ours)).not.toBe(wamidKey(theirs));
    expect(wamidKey(theirs)).toBe(`in:${ID}`);
  });

  it('reads the 32-character ids Cloud API sends carry', () => {
    const id = 'A5000000000000000000000000000001';
    expect(wamidKey(wamid({ user: 'EG.1000000000000001', server: 10, fromMe: true, id }))).toBe(
      `out:${id}`,
    );
  });

  it('accepts a wamid whose padding was dropped', () => {
    expect(wamidKey(BY_PHONE.replace(/=+$/, ''))).toBe(`out:${ID}`);
  });

  it('steps over fields it does not need', () => {
    // An extra i64 (field 4) and string (field 5) after the id, as a later
    // format might add: the key is still the side and the id.
    const base = Buffer.from(BY_PHONE.slice('wamid.'.length), 'base64');
    const extended = Buffer.concat([
      base.subarray(0, base.length - 1),
      Buffer.from([0x16, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01, 0x18, 0x02, 0x6f, 0x6b, 0x00]),
    ]);

    expect(wamidKey(`wamid.${extended.toString('base64')}`)).toBe(`out:${ID}`);
  });

  it('answers null for anything that is not that shape', () => {
    expect(wamidKey('')).toBeNull();
    expect(wamidKey('m_abc123')).toBeNull();
    expect(wamidKey('wamid.')).toBeNull();
    expect(wamidKey('wamid.not-a-wamid')).toBeNull();
    // Truncated mid-id.
    expect(wamidKey(BY_PHONE.slice(0, 30))).toBeNull();
    // No side: an id alone could match the other party's message.
    const noSide = Buffer.from([0x38, ID.length, ...Buffer.from(ID), 0x00]);
    expect(wamidKey(`wamid.${noSide.toString('base64')}`)).toBeNull();
    // A list, which no wamid has carried.
    expect(wamidKey(`wamid.${Buffer.from([0x19, 0x00, 0x00]).toString('base64')}`)).toBeNull();
  });
});
