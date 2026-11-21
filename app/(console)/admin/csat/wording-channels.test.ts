import { describe, expect, it } from 'vitest';
import { ruleChannelLabel, wordingChannelOptions } from './wording-channels';

describe('wordingChannelOptions', () => {
  it('offers the surveyed channels by their console names, the myBlu app among them', () => {
    expect(wordingChannelOptions(null)).toEqual([
      { value: 'email', label: 'Email' },
      { value: 'webchat', label: 'Web chat' },
      { value: 'facebook', label: 'Facebook' },
      { value: 'instagram', label: 'Instagram' },
      { value: 'portal', label: 'Portal' },
      { value: 'api', label: 'myBlu app' },
    ]);
  });

  // Opened with no option matching its value, the browser selected "Every
  // channel", and a save that changed only the wording rescoped the rule.
  it('keeps a stored channel it no longer offers, so editing the wording leaves the scope alone', () => {
    const options = wordingChannelOptions('whatsapp');
    expect(options.at(-1)).toEqual({ value: 'whatsapp', label: 'WhatsApp' });
    expect(options.filter((option) => option.value === 'whatsapp')).toHaveLength(1);
    expect(
      wordingChannelOptions('email').filter((option) => option.value === 'email'),
    ).toHaveLength(1);
  });
});

describe('ruleChannelLabel', () => {
  it('names a rule’s channel, every channel without one, and an unknown value as it is', () => {
    expect(ruleChannelLabel('portal')).toBe('Portal');
    expect(ruleChannelLabel(null)).toBe('Every channel');
    // `in` read inherited keys: `toString` was a channel with a function for a name.
    expect(ruleChannelLabel('toString')).toBe('toString');
  });
});
