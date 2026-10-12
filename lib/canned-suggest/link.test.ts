import { describe, expect, it } from 'vitest';
import { suggestionLink } from './link';

const forNewest = { id: 'S2' };
const taken = { id: 'S1', cannedResponseId: 'where-is-my-order' };

describe('suggestionLink', () => {
  // The reply answers the message on screen, so the suggestion made for it is
  // the one to grade — taken or not, and even when it said `none`.
  it('links the suggestion for the message on screen first', () => {
    expect(suggestionLink(forNewest, taken, ['where-is-my-order'])).toBe('S2');
    expect(suggestionLink(forNewest, null, [])).toBe('S2');
  });

  // Taken with Tab, then the customer wrote again before Send: the text that
  // went in is still in the reply, so that is the suggestion it carried.
  it('falls back to the suggestion taken earlier while its response is still in the box', () => {
    expect(suggestionLink(null, taken, ['where-is-my-order'])).toBe('S1');
    expect(suggestionLink(null, taken, ['greeting', 'where-is-my-order', 'closing'])).toBe('S1');
  });

  // The bug: the agent emptied the box and answered the newer message in their
  // own words. Linking S1 graded Jev wrong about a message it never saw.
  it('links nothing once the box was emptied of what was taken', () => {
    expect(suggestionLink(null, taken, [])).toBeNull();
    expect(suggestionLink(null, taken, ['closing'])).toBeNull();
  });

  it('links nothing when nothing was offered or taken', () => {
    expect(suggestionLink(null, null, ['where-is-my-order'])).toBeNull();
    expect(suggestionLink(null, { id: 'S1', cannedResponseId: null }, [])).toBeNull();
  });
});
