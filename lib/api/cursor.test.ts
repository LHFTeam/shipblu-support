import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { decodeCursor, encodeCursor, THREAD_START } from './cursor';

/**
 * A cursor carries Postgres's own timestamp text, and goes back into a
 * statement behind `::timestamptz`: so one this server did not mint must be
 * refused here, before a query, and "did not mint" is the signature's answer,
 * not the spelling's.
 */

withTestEnv();

const ROW = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

/** What a cursor carries, signed as this server would, under the test's `APP_SECRET`. */
function signedText(time: string, id: string, secret = '0'.repeat(64)): string {
  const mac = createHmac('sha256', secret)
    .update(`myblu-messages-cursor:${time}|${id}`)
    .digest('base64url');
  return `${time}|${id}|${mac}`;
}

const signed = (time: string, id: string, secret?: string) => b64(signedText(time, id, secret));

describe('the message cursor', () => {
  it('carries the text Postgres printed, microseconds and all, through a round trip', () => {
    for (const time of [
      '2026-11-12 09:41:07.004213+00',
      '2026-11-12 09:41:07+00',
      '2026-11-12 11:41:07.5+02',
      '2026-03-29 01:00:00+05:30',
      THREAD_START.time,
    ]) {
      expect(decodeCursor(encodeCursor({ time, id: ROW }))).toEqual({ time, id: ROW });
    }
  });

  it('is the timestamp, the id and their signature, base64url as the contract allows', () => {
    const value = encodeCursor({ time: '2026-11-12 09:41:07.004213+00', id: ROW });
    expect(value).toBe(signed('2026-11-12 09:41:07.004213+00', ROW));
    expect(value).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
    // The longest text Postgres prints, offset seconds and all, still fits.
    expect(encodeCursor({ time: '2026-11-12 09:41:07.004213+05:30:00', id: ROW }).length).toBe(155);
  });

  // The end-to-end pass's own case: base64url of a timestamp and a uuid, in
  // this server's spelling, read as a page from 2026-01-01 until it was signed.
  it('refuses a cursor in this server’s spelling that it never signed', () => {
    const time = '2026-01-01 00:00:00+00';
    const id = '11111111-1111-4111-8111-111111111111';
    expect(decodeCursor(b64(`${time}|${id}`))).toBeNull();
    expect(decodeCursor(b64(`${time}|${id}|`))).toBeNull();
    expect(decodeCursor(signed(time, id, 'another server’s secret, 32 chars long'))).toBeNull();
    expect(decodeCursor(signed(time, id))).toEqual({ time, id });
  });

  it('refuses a signature moved onto another row', () => {
    const minted = Buffer.from(
      encodeCursor({ time: '2026-11-12 09:41:07+00', id: ROW }),
      'base64url',
    ).toString('utf8');
    const mac = minted.split('|')[2]!;
    expect(decodeCursor(b64(`2026-11-12 09:41:08+00|${ROW}|${mac}`))).toBeNull();
    expect(
      decodeCursor(b64(`2026-11-12 09:41:07+00|00000000-0000-0000-0000-000000000000|${mac}`)),
    ).toBeNull();
  });

  // A change of `APP_SECRET` refuses what an app holds, once: the SDK drops
  // the cursor and reads the newest page.
  it('refuses every cursor signed under the secret before a change', () => {
    const before = encodeCursor({ time: '2026-11-12 09:41:07+00', id: ROW });
    setTestEnv({ APP_SECRET: '1'.repeat(64) });
    expect(decodeCursor(before)).toBeNull();
    expect(decodeCursor(encodeCursor({ time: '2026-11-12 09:41:07+00', id: ROW }))).toEqual({
      time: '2026-11-12 09:41:07+00',
      id: ROW,
    });
  });

  it.each([
    ['not base64url text', 'not a cursor!'],
    ['no separator', b64(`2026-11-12 09:41:07+00${ROW}`)],
    ['a separator too many', b64(`${signedText('2026-11-12 09:41:07+00', ROW)}|x`)],
    ['something added after it', `${signed('2026-11-12 09:41:07+00', ROW)}!`],
  ])('refuses %s', (_, value) => {
    expect(decodeCursor(value)).toBeNull();
  });

  // Signed, as only the secret can: the statement never depends on the
  // secret alone to keep out a text Postgres would answer with a 500.
  it.each([
    ['no timestamp', '', ROW],
    ['an id that is not a uuid', '2026-11-12 09:41:07+00', 'row-1'],
    ['an ISO instant, which Postgres does not print', '2026-11-12T09:41:07.004Z', ROW],
    ['a day that does not exist', '2026-02-30 09:41:07+00', ROW],
    ['an hour that does not exist', '2026-11-12 24:00:00+00', ROW],
    ['words where the time goes', 'now', ROW],
  ])('refuses %s, even signed', (_, time, id) => {
    expect(decodeCursor(signed(time, id))).toBeNull();
  });
});
