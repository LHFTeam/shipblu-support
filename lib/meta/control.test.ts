import { describe, expect, it } from 'vitest';
import {
  anotherAppHoldsThread,
  controlReadingWins,
  describeAppId,
  metaControlState,
  PAGE_INBOX_APP_ID,
  parseThreadOwner,
} from './control';

const OURS = '111222333';

describe('parseThreadOwner', () => {
  it('reads the documented shape', () => {
    const reading = parseThreadOwner({
      data: [{ thread_owner: { app_id: 263902037430900, expiration: 1758000000 } }],
    });

    expect(reading.appId).toBe('263902037430900');
    expect(reading.expiresAt?.toISOString()).toBe('2025-09-16T05:20:00.000Z');
  });

  /*
    The reason this is normalised rather than compared as-is. Graph's own
    example prints `app_id` as a bare JSON number; real responses send a string.
    A number compared with `===` against META_APP_ID never matches, and the
    button would offer to take a thread this app already owns — silently, and
    only on whichever of the two shapes we did not expect.
  */
  it('normalises a numeric app id to a string', () => {
    expect(parseThreadOwner({ data: [{ thread_owner: { app_id: 12345 } }] }).appId).toBe('12345');
  });

  it('reads an owned thread whose owner Graph will not name', () => {
    const reading = parseThreadOwner({ data: [{ thread_owner: { expiration: 1758000000 } }] });

    expect(reading.appId).toBeNull();
    expect(reading.expiresAt).not.toBeNull();
  });

  it('reads an idle thread as nothing at all', () => {
    expect(parseThreadOwner({ data: [] })).toEqual({ appId: null, expiresAt: null });
    expect(parseThreadOwner({})).toEqual({ appId: null, expiresAt: null });
    expect(parseThreadOwner(null)).toEqual({ appId: null, expiresAt: null });
  });

  it('accepts an expiration already in milliseconds', () => {
    const reading = parseThreadOwner({
      data: [{ thread_owner: { app_id: '1', expiration: 1758000000000 } }],
    });

    expect(reading.expiresAt?.toISOString()).toBe('2025-09-16T05:20:00.000Z');
  });
});

describe('metaControlState', () => {
  it('offers release when this app is the owner', () => {
    const state = metaControlState({
      platform: 'facebook',
      ourAppId: OURS,
      reading: { appId: OURS, expiresAt: null },
      standby: false,
    });

    expect(state.holder).toBe('us');
    expect(state.intent).toBe('release');
    expect(state.label).toBe('Release control');
  });

  it('offers a transfer when a named app is the owner', () => {
    const state = metaControlState({
      platform: 'facebook',
      ourAppId: OURS,
      reading: { appId: PAGE_INBOX_APP_ID, expiresAt: null },
      standby: true,
    });

    expect(state.holder).toBe('other');
    expect(state.ownerAppId).toBe(PAGE_INBOX_APP_ID);
    expect(state.intent).toBe('take');
    expect(state.explanation).toContain('Facebook Page inbox');
  });

  /*
    The case the whole module exists for. Graph names the owner only to the
    owner and to the page's default app, so an expiration with no id is not
    ambiguity — it is proof that somebody holds the thread and that we are
    neither of those two. Reading it as "unknown, do nothing" would leave the
    agent on an unanswerable ticket with no button.
  */
  it('treats an expiration with no app id as another app owning it', () => {
    const state = metaControlState({
      platform: 'instagram',
      ourAppId: OURS,
      reading: { appId: null, expiresAt: new Date('2026-01-01T00:00:00Z') },
      standby: false,
    });

    expect(state.holder).toBe('other');
    expect(state.ownerAppId).toBeNull();
    expect(state.intent).toBe('take');
  });

  it('treats an empty reading as idle and still offers to take it', () => {
    const state = metaControlState({
      platform: 'facebook',
      ourAppId: OURS,
      reading: { appId: null, expiresAt: null },
      standby: false,
    });

    expect(state.holder).toBe('idle');
    expect(state.intent).toBe('take');
  });

  it('falls back to the standby flag when there is no reading', () => {
    const blocked = metaControlState({
      platform: 'facebook',
      ourAppId: OURS,
      reading: null,
      standby: true,
    });
    expect(blocked.holder).toBe('unknown');
    expect(blocked.intent).toBe('take');

    const open = metaControlState({
      platform: 'facebook',
      ourAppId: OURS,
      reading: null,
      standby: false,
    });
    expect(open.intent).toBe('release');
  });

  it('offers nothing at all without our own app id to compare against', () => {
    const state = metaControlState({
      platform: 'facebook',
      ourAppId: null,
      reading: { appId: OURS, expiresAt: null },
      standby: false,
    });

    expect(state.intent).toBeNull();
    expect(state.blockedReason).toContain('META_APP_ID');
  });
});

describe('describeAppId', () => {
  it('names Meta’s own inboxes', () => {
    expect(describeAppId(PAGE_INBOX_APP_ID)).toBe('the Facebook Page inbox');
    expect(describeAppId('1217981644879628')).toBe('the Instagram inbox');
    expect(describeAppId('999')).toBe('app 999');
    expect(describeAppId(null)).toBe('no app');
  });
});

describe('controlReadingWins', () => {
  const earlier = new Date('2026-08-01T10:00:00Z');
  const later = new Date('2026-08-01T11:00:00Z');

  it('prefers a snapshot taken after the last inbound message', () => {
    expect(controlReadingWins(later, earlier)).toBe(true);
  });

  it('yields to a message that arrived after the snapshot', () => {
    expect(controlReadingWins(earlier, later)).toBe(false);
  });

  it('has nothing to say without a snapshot', () => {
    expect(controlReadingWins(null, earlier)).toBe(false);
  });

  it('wins when there is no inbound message to be older than', () => {
    expect(controlReadingWins(earlier, null)).toBe(true);
  });
});

describe('anotherAppHoldsThread', () => {
  const inboundAt = new Date('2026-08-01T10:00:00Z');
  const afterwards = new Date('2026-08-01T10:05:00Z');
  const before = new Date('2026-08-01T09:00:00Z');

  /*
    The bug this arbitration prevents. An agent presses "transfer control",
    Graph agrees, and the newest inbound message goes on saying `standby`
    because that is what was true when it arrived. Without the timestamps the
    composer would keep refusing replies the agent has just earned the right to
    send, until the customer happened to write again.
  */
  it('lets a take taken after the last message unblock the composer', () => {
    expect(
      anotherAppHoldsThread({
        ourAppId: OURS,
        control: { appId: OURS, checkedAt: afterwards },
        lastInboundStandby: true,
        lastInboundAt: inboundAt,
      }),
    ).toBe(false);
  });

  it('lets a newer message override a stale snapshot of our own ownership', () => {
    expect(
      anotherAppHoldsThread({
        ourAppId: OURS,
        control: { appId: OURS, checkedAt: before },
        lastInboundStandby: true,
        lastInboundAt: inboundAt,
      }),
    ).toBe(true);
  });

  it('blocks when a fresh snapshot names another app', () => {
    expect(
      anotherAppHoldsThread({
        ourAppId: OURS,
        control: { appId: PAGE_INBOX_APP_ID, checkedAt: afterwards },
        lastInboundStandby: false,
        lastInboundAt: inboundAt,
      }),
    ).toBe(true);
  });

  /*
    Idle deliberately does not block. Meta says only the page's default app may
    send into an idle thread and gives us no way to ask whether we are it, so
    blocking would refuse replies that work today on the strength of a guess.
  */
  it('does not block an idle thread', () => {
    expect(
      anotherAppHoldsThread({
        ourAppId: OURS,
        control: { appId: null, checkedAt: afterwards },
        lastInboundStandby: true,
        lastInboundAt: inboundAt,
      }),
    ).toBe(false);
  });

  it('behaves exactly as the standby flag alone when nothing was ever read', () => {
    expect(
      anotherAppHoldsThread({
        ourAppId: OURS,
        control: null,
        lastInboundStandby: true,
        lastInboundAt: inboundAt,
      }),
    ).toBe(true);

    expect(
      anotherAppHoldsThread({
        ourAppId: OURS,
        control: { appId: null, checkedAt: null },
        lastInboundStandby: true,
        lastInboundAt: inboundAt,
      }),
    ).toBe(true);
  });
});
