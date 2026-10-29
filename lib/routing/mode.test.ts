import { describe, expect, it } from 'vitest';
import { routingModeEnum, routingOutcomeEnum } from '@/db/schema/enums';
import { CATEGORY_AI_MODES } from '@/lib/category-ai/modes';
import { ROUTING_OUTCOMES } from './decide';
import { ROUTING_MODES, isRoutingMode, routingModeOf, routingStartFor } from './mode';

/**
 * The one reader of a channel's routing mode (`plans/ticket-category-routing.md`,
 * decision 5), and the lists the client-safe modules keep beside the enums
 * they cannot import.
 */

/** A row the Business app and Cloud API share, as onboarding writes it. */
const COEXISTENCE = {
  phoneNumberId: '1092',
  coexistence: { onboardedAt: '2026-09-01T10:00:00.000Z', wabaId: 'waba-1' },
};

describe('the lists kept beside the enums', () => {
  // `mode.ts` and `decide.ts` are imported by client components, which must not
  // pull in the schema (§6.57); so each keeps a copy, and this is what keeps it.
  it('ROUTING_MODES is routingModeEnum', () => {
    expect([...ROUTING_MODES]).toEqual(routingModeEnum.enumValues);
  });

  it('ROUTING_OUTCOMES is routingOutcomeEnum', () => {
    expect([...ROUTING_OUTCOMES]).toEqual(routingOutcomeEnum.enumValues);
  });

  it('isRoutingMode accepts the three and nothing else', () => {
    for (const mode of ROUTING_MODES) expect(isRoutingMode(mode)).toBe(true);
    for (const value of ['categories', 'Category', '', null, undefined, 1]) {
      expect(isRoutingMode(value)).toBe(false);
    }
  });
});

describe('routingModeOf', () => {
  it.each(ROUTING_MODES)('reads %s off an ordinary row', (mode) => {
    expect(routingModeOf({ type: 'email', config: {}, routingMode: mode })).toBe(mode);
    expect(
      routingModeOf({ type: 'whatsapp', config: { phoneNumberId: '1092' }, routingMode: mode }),
    ).toBe(mode);
  });

  it('keeps a coexistence number on its default group, whatever the column says', () => {
    // Its replies are typed on the phone: routing its tickets changes nothing
    // about who answers them.
    expect(routingModeOf({ type: 'whatsapp', config: COEXISTENCE, routingMode: 'category' })).toBe(
      'default_group',
    );
    expect(
      routingModeOf({ type: 'whatsapp', config: COEXISTENCE, routingMode: 'category_shadow' }),
    ).toBe('default_group');
  });

  it('reads coexistence only on a WhatsApp row', () => {
    expect(routingModeOf({ type: 'email', config: COEXISTENCE, routingMode: 'category' })).toBe(
      'category',
    );
  });

  it('keeps the bot on its default group', () => {
    // A transcript runs no creation pass, so a held one would wait for nothing.
    expect(routingModeOf({ type: 'whatsapp_bot', config: {}, routingMode: 'category' })).toBe(
      'default_group',
    );
    expect(
      routingModeOf({ type: 'whatsapp_bot', config: {}, routingMode: 'category_shadow' }),
    ).toBe('default_group');
  });

  it.each(['categories', 'CATEGORY', '', null])(
    'reads %j, a value it does not know, as default_group',
    (value) => {
      expect(routingModeOf({ type: 'email', config: {}, routingMode: value })).toBe(
        'default_group',
      );
    },
  );
});

describe('routingStartFor', () => {
  it('starts a live hold on category and a record on category_shadow, in apply', () => {
    expect(routingStartFor('category', 'apply')).toBe('live');
    expect(routingStartFor('category_shadow', 'apply')).toBe('shadow');
    expect(routingStartFor('default_group', 'apply')).toBeNull();
  });

  it.each(CATEGORY_AI_MODES.filter((mode) => mode !== 'apply'))(
    'starts nothing while the classifier is %s, which files no category to wait for',
    (classifier) => {
      for (const mode of ROUTING_MODES) expect(routingStartFor(mode, classifier)).toBeNull();
    },
  );
});
