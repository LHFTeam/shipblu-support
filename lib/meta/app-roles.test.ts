import { describe, expect, it } from 'vitest';
import { defaultAppSinceFrom } from './app-roles';

const US = '1009187740467732';
const FRESHWORKS = '576817601276249';
const SWITCH = new Date('2026-11-05T10:30:24Z');

const at = (iso: string) => new Date(iso);

describe('defaultAppSinceFrom', () => {
  it('answers the instant this app became the Instagram default', () => {
    // The event production holds (docs/PROJECT-STATE.md §6.111).
    expect(
      defaultAppSinceFrom('instagram', [{ appId: US, roles: ['default_app'], at: SWITCH }], US),
    ).toEqual(SWITCH);
  });

  it('never answers for Messenger, whose switch moved no thread', () => {
    // The Page's own event named this app default_app twelve seconds earlier,
    // and every Messenger message since has still arrived in standby.
    expect(
      defaultAppSinceFrom(
        'facebook',
        [{ appId: US, roles: ['default_app'], at: at('2026-11-05T10:30:12Z') }],
        US,
      ),
    ).toBeNull();
  });

  it('is null without an app id, or without an event naming this app the default', () => {
    expect(
      defaultAppSinceFrom('instagram', [{ appId: US, roles: ['default_app'], at: SWITCH }], null),
    ).toBeNull();
    expect(defaultAppSinceFrom('instagram', [], US)).toBeNull();
    expect(
      defaultAppSinceFrom(
        'instagram',
        [{ appId: US, roles: ['secondary_receiver'], at: SWITCH }],
        US,
      ),
    ).toBeNull();
  });

  it('is null once the default has gone, to another app or from this one', () => {
    const switched = { appId: US, roles: ['default_app'], at: SWITCH };

    expect(
      defaultAppSinceFrom(
        'instagram',
        [switched, { appId: FRESHWORKS, roles: ['default_app'], at: at('2026-11-20T09:00:00Z') }],
        US,
      ),
    ).toBeNull();
    expect(
      defaultAppSinceFrom(
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
      defaultAppSinceFrom(
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
      defaultAppSinceFrom(
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
