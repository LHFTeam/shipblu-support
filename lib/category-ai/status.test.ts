import { describe, expect, it } from 'vitest';
import { jevStatus } from './status';

describe('jevStatus', () => {
  it('says what Jev does when it has a key to ask with', () => {
    expect(jevStatus('apply', true, 0.6)).toEqual({
      bold: 'filing tickets',
      tail: ', at a threshold of 0.6.',
    });
    expect(jevStatus('shadow', true, 0.6).bold).toBe(
      'in shadow: asked, and its answers recorded, with no ticket changed',
    );
  });

  it('says only what the switch is set to when there is no key, and that nothing happens', () => {
    expect(jevStatus('apply', false, 0.6)).toEqual({
      bold: 'set to file tickets',
      tail: ', at a threshold of 0.6, but this environment has no TYPESAFE_API_KEY, so it is asked nothing and files nothing.',
    });
    expect(jevStatus('shadow', false, 0.6)).toEqual({
      bold: 'set to shadow',
      tail: ', at a threshold of 0.6, but this environment has no TYPESAFE_API_KEY, so it is asked nothing and records nothing.',
    });
  });

  it('never claims work while there is no key', () => {
    for (const mode of ['shadow', 'apply'] as const) {
      const { bold } = jevStatus(mode, false, 0.6);
      expect(bold).not.toMatch(/filing tickets|asked, and its answers recorded/);
    }
  });

  it('says off without a threshold, key or not', () => {
    expect(jevStatus('off', true, 0.6)).toEqual({ bold: 'switched off', tail: '.' });
    expect(jevStatus('off', false, 0.6)).toEqual({ bold: 'switched off', tail: '.' });
  });
});
