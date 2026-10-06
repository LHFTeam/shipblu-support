import { describe, expect, it } from 'vitest';
import { ATTACHMENT_URL_TTL_SECONDS, reloadDelayMs, shouldRefresh } from './signed-url';

const minutes = (n: number) => n * 60_000;
const note = { duration: 12.4, buffered: [[0, 12.4]] as Array<[number, number]> };
const video = { duration: 240, buffered: [[0, 95]] as Array<[number, number]> };

describe('shouldRefresh', () => {
  it('leaves an element alone before anything has been signed for it', () => {
    for (const trigger of ['play', 'seeking', 'waiting', 'stalled', 'error'] as const) {
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
    const young = { ageMs: minutes(3), position: 95, readyState: 1, ...video };
    expect(shouldRefresh('waiting', young)).toBe(false);
    expect(shouldRefresh('stalled', young)).toBe(false);
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
    expect(shouldRefresh('waiting', { ageMs: minutes(6), position: 94.6, ...video })).toBe(true);
  });

  it('does not take a seek inside the buffer for starvation on an old URL', () => {
    expect(shouldRefresh('waiting', { ageMs: minutes(6), position: 40, ...video })).toBe(false);
  });

  it('reloads a play or a seek into what an old URL never fetched', () => {
    const old = { ageMs: minutes(6), ...video };
    expect(shouldRefresh('play', { ...old, position: 95.5 })).toBe(true);
    expect(shouldRefresh('seeking', { ...old, position: 200 })).toBe(true);
  });

  it('wants at least a second buffered ahead, and no more', () => {
    const old = { ageMs: minutes(6), ...video };
    expect(shouldRefresh('play', { ...old, position: 93.9 })).toBe(false);
    expect(shouldRefresh('play', { ...old, position: 94.1 })).toBe(true);
  });

  it('does not count a range that starts after the position as buffered ahead of it', () => {
    // Seeked ahead to 60 earlier, now back to 30, in the gap between the two.
    expect(
      shouldRefresh('seeking', {
        ageMs: minutes(6),
        position: 30,
        duration: 240,
        buffered: [
          [0, 10],
          [60, 95],
        ],
      }),
    ).toBe(true);
  });

  it('counts buffered-to-the-end as enough, however close the position is to it', () => {
    expect(shouldRefresh('play', { ageMs: minutes(6), position: 12.2, ...note })).toBe(false);
  });

  it('lets a slow response that is still arriving stall without throwing it away', () => {
    const edge = { ageMs: minutes(6), position: 94.6, ...video };
    expect(shouldRefresh('waiting', { ...edge, sinceDataMs: 400 })).toBe(false);
    expect(shouldRefresh('waiting', { ...edge, sinceDataMs: 3_500 })).toBe(true);
    expect(shouldRefresh('waiting', { ...edge, sinceDataMs: null })).toBe(true);
  });

  it('reloads an old URL that stalls with nothing to play, whatever buffered claims', () => {
    // Chrome's buffered for a faststart MP4 runs 1.3 s past where it starved.
    const starved = { ageMs: minutes(6), position: 93.7, ...video };
    expect(shouldRefresh('waiting', starved)).toBe(false);
    expect(shouldRefresh('stalled', { ...starved, readyState: 2 })).toBe(true);
    expect(shouldRefresh('stalled', { ...starved, readyState: 4 })).toBe(false);
  });

  it('refreshes a minute inside the TTL, not at it', () => {
    const play = (ageMs: number) => shouldRefresh('play', { ageMs, position: 100, ...video });
    expect(play((ATTACHMENT_URL_TTL_SECONDS - 61) * 1000)).toBe(false);
    expect(play((ATTACHMENT_URL_TTL_SECONDS - 60) * 1000)).toBe(true);
    expect(play((ATTACHMENT_URL_TTL_SECONDS - 30) * 1000)).toBe(true);
  });
});

describe('reloadDelayMs', () => {
  it('reloads at once after one error, and spaces out the reloads that themselves failed', () => {
    expect([1, 2, 3].map(reloadDelayMs)).toEqual([0, 1_000, 2_000]);
  });
});
