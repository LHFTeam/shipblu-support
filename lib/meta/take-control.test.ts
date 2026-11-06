import { describe, expect, it } from 'vitest';
import { takeControlRefusal } from './take-control';
import { metaThreadState } from './thread';
import { metaWindowState } from './window';

const PAGE = '955333171001884';
const IG_ACCOUNT = '17841448759001625';
const NOW = new Date('2026-11-06T12:00:00Z');

const messengerStandby = metaThreadState({
  platform: 'facebook',
  connection: 'facebook_page',
  inboundAccountId: PAGE,
  configuredAccountId: PAGE,
  standby: true,
  inboundConnection: 'facebook_page',
});

const instagramStandby = metaThreadState({
  platform: 'instagram',
  connection: 'unified_login',
  inboundAccountId: IG_ACCOUNT,
  configuredAccountId: IG_ACCOUNT,
  standby: true,
  inboundConnection: 'facebook_page',
});

const wroteAgo = (hours: number) =>
  metaWindowState(new Date(NOW.getTime() - hours * 3_600_000), NOW);

describe('takeControlRefusal', () => {
  // The composer draws the button only where this answers null, and
  // claimThreadControl refuses with what it answers otherwise; the two
  // disagreeing is docs/PROJECT-STATE.md §6.111.
  it('offers the button on a Messenger standby inside the window', () => {
    expect(takeControlRefusal(messengerStandby, wroteAgo(2))).toBeNull();
    expect(takeControlRefusal(messengerStandby, wroteAgo(30))).toBeNull();
  });

  it('refuses an Instagram standby with the verdict’s own words', () => {
    const refusal = takeControlRefusal(instagramStandby, wroteAgo(2));

    expect(refusal).toContain('Thread control cannot be taken on this ticket.');
    expect(refusal).toContain(instagramStandby.explanation!);
  });

  it('refuses once the seven days are gone, and says why', () => {
    const refusal = takeControlRefusal(messengerStandby, wroteAgo(24 * 9));

    expect(refusal).toContain('7-day window has closed');
    expect(refusal).toContain('only take it from the other tool');
  });

  it('leaves a thread with no customer message to the recipient check', () => {
    // never_opened is closed too, but there is no standby to take and nobody
    // to address; the action says that better than the window would.
    expect(takeControlRefusal(messengerStandby, metaWindowState(null, NOW))).toBeNull();
  });

  it('takes an unknown clock as open, as the composer does before it mounts', () => {
    expect(takeControlRefusal(messengerStandby, null)).toBeNull();
    expect(takeControlRefusal(instagramStandby, null)).not.toBeNull();
  });
});
