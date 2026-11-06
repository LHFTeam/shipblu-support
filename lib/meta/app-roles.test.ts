import { describe, expect, it } from 'vitest';
import { defaultAppStandingFrom } from './app-roles';

const US = '1009187740467732';
const FRESHWORKS = '576817601276249';
const SWITCH = new Date('2026-11-05T10:30:24Z');

const at = (iso: string) => new Date(iso);

const sinceFrom = (...args: Parameters<typeof defaultAppStandingFrom>) =>
  defaultAppStandingFrom(...args).since;
const lostFrom = (...args: Parameters<typeof defaultAppStandingFrom>) =>
  defaultAppStandingFrom(...args).lostAt;

describe('defaultAppStandingFrom', () => {
  it('answers the instant this app became the Instagram default', () => {
    // The event production holds (docs/PROJECT-STATE.md §6.111).
    expect(sinceFrom('instagram', [{ appId: US, roles: ['default_app'], at: SWITCH }], US)).toEqual(
      SWITCH,
    );
  });

  it('never answers for Messenger, whose switch moved no thread', () => {
    // The Page's own event named this app default_app twelve seconds earlier,
    // and every Messenger message since has still arrived in standby.
    expect(
      sinceFrom(
        'facebook',
        [{ appId: US, roles: ['default_app'], at: at('2026-11-05T10:30:12Z') }],
        US,
      ),
    ).toBeNull();
  });

  it('is null without an app id, or without an event naming this app the default', () => {
    expect(
      sinceFrom('instagram', [{ appId: US, roles: ['default_app'], at: SWITCH }], null),
    ).toBeNull();
    expect(sinceFrom('instagram', [], US)).toBeNull();
    expect(
      sinceFrom('instagram', [{ appId: US, roles: ['secondary_receiver'], at: SWITCH }], US),
    ).toBeNull();
  });

  it('is null once the default has gone, to another app or from this one', () => {
    const switched = { appId: US, roles: ['default_app'], at: SWITCH };

    expect(
      sinceFrom(
        'instagram',
        [switched, { appId: FRESHWORKS, roles: ['default_app'], at: at('2026-11-20T09:00:00Z') }],
        US,
      ),
    ).toBeNull();
    expect(
      sinceFrom(
        'instagram',
        [switched, { appId: US, roles: [], at: at('2026-11-20T09:00:00Z') }],
        US,
      ),
    ).toBeNull();
  });

  it('answers the start of the current stretch, not its latest event', () => {
    // A standby received between the two says another app took that thread;
    // the second statement of the same role is no evidence it gave it back.
    expect(
      sinceFrom(
        'instagram',
        [
          { appId: US, roles: ['default_app'], at: at('2026-11-20T09:00:00Z') },
          { appId: US, roles: ['default_app'], at: SWITCH },
          // Before the stretch: the default went to another app and came back.
          { appId: FRESHWORKS, roles: ['default_app'], at: at('2026-11-01T00:00:00Z') },
          { appId: US, roles: ['default_app'], at: at('2026-10-01T00:00:00Z') },
        ],
        US,
      ),
    ).toEqual(SWITCH);
  });

  it("ignores another app's other roles", () => {
    expect(
      sinceFrom(
        'instagram',
        [
          { appId: FRESHWORKS, roles: ['secondary_receiver'], at: at('2026-11-20T09:00:00Z') },
          { appId: US, roles: ['default_app'], at: SWITCH },
        ],
        US,
      ),
    ).toEqual(SWITCH);
  });
});

describe('defaultAppStandingFrom, a switch away', () => {
  const switched = { appId: US, roles: ['default_app'], at: SWITCH };
  const LATER = at('2026-12-01T09:00:00Z');

  it('answers when the default went to another app, or left this one', () => {
    expect(
      lostFrom(
        'instagram',
        [switched, { appId: FRESHWORKS, roles: ['default_app'], at: LATER }],
        US,
      ),
    ).toEqual(LATER);
    expect(lostFrom('instagram', [switched, { appId: US, roles: [], at: LATER }], US)).toEqual(
      LATER,
    );
  });

  it('answers only one of the two, by the newest switch', () => {
    const standing = defaultAppStandingFrom(
      'instagram',
      [
        { appId: FRESHWORKS, roles: ['default_app'], at: at('2026-11-20T09:00:00Z') },
        { appId: US, roles: ['default_app'], at: LATER },
      ],
      US,
    );
    expect(standing).toEqual({ since: LATER, lostAt: null });
  });

  it("ignores another app's other roles, and never answers for Messenger", () => {
    expect(
      lostFrom(
        'instagram',
        [switched, { appId: FRESHWORKS, roles: ['secondary_receiver'], at: LATER }],
        US,
      ),
    ).toBeNull();
    expect(
      lostFrom('facebook', [{ appId: FRESHWORKS, roles: ['default_app'], at: LATER }], US),
    ).toBeNull();
  });
});
