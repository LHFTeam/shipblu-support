import { describe, expect, it } from 'vitest';
import { deliveryId } from './delivery';

/** One real Instagram message, as each connection delivers it. */
const MID =
  'aWdfZAG1faXRlbToxOklHTWVzc2FnZAUlEOjE3ODQxNDQ4NzU5MDAxNjI1OjM0MDI4MjM2Njg0MTcxMDMwMTI0NDI1';

const viaDirect = {
  object: 'instagram',
  entry: [
    {
      id: '17841448759001625',
      messaging: [{ sender: { id: 'igsid-1' }, message: { mid: MID, text: 'hi' } }],
    },
  ],
};

/**
 * The same message reaching the Page connection. It arrives in `standby`
 * because Freshworks holds thread control there — the envelope differs, the
 * `mid` does not.
 */
const viaPage = {
  object: 'instagram',
  entry: [
    {
      id: '17841448759001625',
      standby: [{ sender: { id: 'igsid-1' }, message: { mid: MID, text: 'hi' } }],
    },
  ],
};

describe('deliveryId', () => {
  it('gives the two connections different keys for the same message', () => {
    /*
      Verified against production before it was written: on 2026-08-27 one mid
      appeared in a `messaging` delivery signed by the Instagram app secret and
      in a `standby` delivery signed by META_APP_SECRET, seconds apart. Keying
      on the contents alone collapsed those onto one row, so whichever arrived
      first became the whole record and the other was answered 200 and
      discarded — which makes a per-connection delivery count, the number that
      shows a connection going silent, impossible to compute.
    */
    expect(deliveryId(viaDirect, 'instagram_login')).not.toBe(deliveryId(viaPage, 'facebook_page'));
  });

  it('still collapses a redelivery on the same connection', () => {
    // The property that must survive: Meta retries the whole batch on a failed
    // or slow response, and a retry is not a second customer message.
    expect(deliveryId(viaDirect, 'instagram_login')).toBe(deliveryId(viaDirect, 'instagram_login'));
  });

  it('does not depend on the order events arrive in', () => {
    const forwards = {
      object: 'page',
      entry: [
        {
          id: '1',
          messaging: [{ message: { mid: 'a' } }, { message: { mid: 'b' } }],
        },
      ],
    };
    const backwards = {
      object: 'page',
      entry: [
        {
          id: '1',
          messaging: [{ message: { mid: 'b' } }, { message: { mid: 'a' } }],
        },
      ],
    };

    expect(deliveryId(forwards, 'facebook_page')).toBe(deliveryId(backwards, 'facebook_page'));
  });

  it('keys a comment on the comment and its verb', () => {
    const key = deliveryId(
      {
        object: 'instagram',
        entry: [
          {
            id: '17841448759001625',
            changes: [{ field: 'comments', value: { id: '18618316756031483' } }],
          },
        ],
      },
      'instagram_login',
    );

    expect(key).toContain('18618316756031483');
    expect(key).toContain('instagram_login');
  });

  it('has no key for a batch with nothing in it', () => {
    // Nulls are distinct to the unique index, so an empty batch gets a row of
    // its own rather than colliding with every other empty batch.
    expect(deliveryId({ object: 'page', entry: [{ id: '1' }] }, 'facebook_page')).toBeNull();
    expect(deliveryId({}, 'facebook_page')).toBeNull();
  });

  it('keys a postback-only batch, which used to have no key at all', () => {
    // A button press carries no message and no comment, so before interactions
    // were parsed this batch produced no parts and a null key — and nulls are
    // distinct to the unique index, so every redelivery of the same press was
    // stored and processed again.
    const press = {
      object: 'page' as const,
      entry: [
        {
          id: '1',
          messaging: [
            {
              sender: { id: 'psid-1' },
              timestamp: 1_755_000_000_000,
              postback: { title: 'Get Started', payload: 'GET_STARTED' },
            },
          ],
        },
      ],
    };

    const key = deliveryId(press, 'facebook_page');
    expect(key).not.toBeNull();
    expect(deliveryId(press, 'facebook_page')).toBe(key);
  });

  it('tells a reaction apart from taking it back', () => {
    // A reaction's `mid` names the message reacted *to*, so keying on it alone
    // would collide react with unreact and silently discard the second.
    const react = (action: string) => ({
      object: 'page' as const,
      entry: [
        {
          id: '1',
          messaging: [{ sender: { id: 'psid-1' }, reaction: { mid: 'm_abc', action } }],
        },
      ],
    });

    expect(deliveryId(react('react'), 'facebook_page')).not.toBe(
      deliveryId(react('unreact'), 'facebook_page'),
    );
  });

  it('stays inside the column it is written to', () => {
    const many = {
      object: 'page',
      entry: [
        {
          id: '1',
          messaging: Array.from({ length: 200 }, (_, i) => ({
            message: { mid: `mid-${'x'.repeat(40)}-${i}` },
          })),
        },
      ],
    };

    expect(deliveryId(many, 'facebook_page')!.length).toBeLessThanOrEqual(500);
  });
});
