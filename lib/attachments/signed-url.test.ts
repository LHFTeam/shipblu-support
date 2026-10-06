import { describe, expect, it } from 'vitest';
import { ATTACHMENT_URL_TTL_SECONDS, shouldRefresh } from './signed-url';

const minutes = (n: number) => n * 60_000;
const note = { duration: 12.4, buffered: [[0, 12.4]] as Array<[number, number]> };
const video = { duration: 240, buffered: [[0, 95]] as Array<[number, number]> };

describe('shouldRefresh', () => {
  it('leaves an element alone before anything has been signed for it', () => {
    for (const trigger of ['play', 'seeking', 'waiting', 'error'] as const) {
      expect(
        shouldRefresh(trigger, { ageMs: null, position: 0, duration: NaN, buffered: [] }),
      ).toBe(false);
    }
  });

  it('reloads on a network error once metadata had arrived, however young the URL', () => {
    expect(shouldRefresh('error', { ageMs: 1_000, position: 3, errorCode: 2, ...note })).toBe(true);
  });

  it('takes a decode error on a young URL for the file, and on an old one for a dead range', () => {
    expect(shouldRefresh('error', { ageMs: 1_000, position: 3, errorCode: 3, ...note })).toBe(
      false,
    );
    expect(shouldRefresh('error', { ageMs: minutes(6), position: 3, errorCode: 3, ...note })).toBe(
      true,
    );
  });

  it('never reloads a source that was refused outright', () => {
    expect(shouldRefresh('error', { ageMs: minutes(6), position: 3, errorCode: 4, ...note })).toBe(
      false,
    );
  });

  it('trusts a young URL through a stall, a play or a seek', () => {
    const young = { ageMs: minutes(3), position: 95, ...video };
    expect(shouldRefresh('waiting', young)).toBe(false);
    expect(shouldRefresh('play', young)).toBe(false);
    expect(shouldRefresh('seeking', { ...young, position: 200 })).toBe(false);
  });

  it('replays a voice note that arrived whole without asking again, an hour later', () => {
    const old = { ageMs: minutes(60), ...note };
    expect(shouldRefresh('play', { ...old, position: 0 })).toBe(false);
    expect(shouldRefresh('seeking', { ...old, position: 12.4 })).toBe(false);
    // Chrome fires "waiting" on a seek into buffered data as well.
    expect(shouldRefresh('waiting', { ...old, position: 0 })).toBe(false);
  });

  it('reloads a stall at the edge of what an old URL fetched', () => {
    expect(shouldRefresh('waiting', { ageMs: minutes(4), position: 94.6, ...video })).toBe(true);
  });

  it('does not take a seek inside the buffer for starvation on an old URL', () => {
    expect(shouldRefresh('waiting', { ageMs: minutes(6), position: 40, ...video })).toBe(false);
  });

  it('reloads a play or a seek into what an old URL never fetched', () => {
    const old = { ageMs: minutes(6), ...video };
    expect(shouldRefresh('play', { ...old, position: 95.5 })).toBe(true);
    expect(shouldRefresh('seeking', { ...old, position: 200 })).toBe(true);
  });

  it('counts buffered-to-the-end as enough, however close the position is to it', () => {
    expect(shouldRefresh('play', { ageMs: minutes(6), position: 12.2, ...note })).toBe(false);
  });

  it('refreshes inside the TTL, not at it', () => {
    const atDeadline = {
      ageMs: ATTACHMENT_URL_TTL_SECONDS * 1000,
      position: 100,
      ...video,
    };
    expect(shouldRefresh('play', atDeadline)).toBe(true);
    expect(
      shouldRefresh('play', { ...atDeadline, ageMs: (ATTACHMENT_URL_TTL_SECONDS - 61) * 1000 }),
    ).toBe(false);
  });
});
