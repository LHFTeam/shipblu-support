import { describe, expect, it } from 'vitest';
import { initials } from './initials';

/**
 * The avatar falls back to initials for every contact without a picture, which
 * is most of them — so this runs on names from every channel the console has,
 * and the channel that breaks it is Instagram, where a display name is whatever
 * the person typed.
 */
describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Ali Hassan')).toBe('AH');
    expect(initials('mona')).toBe('M');
    expect(initials('Mona Sayed Abdel Rahman')).toBe('MR');
  });

  it('says nothing rather than guessing when there is no name', () => {
    // The state every Messenger contact was in before the profile lookup
    // existed: a ticket with an id and no person attached to it.
    expect(initials(null)).toBe('?');
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });

  it('keeps an emoji whole', () => {
    // Indexing with [0] takes half a surrogate pair and renders as U+FFFD. An
    // Instagram display name starting with an emoji is common enough that this
    // is the realistic first-render for a customer, not an edge case.
    expect(initials('🌙 Layla')).toBe('🌙L');
    expect(initials('🌙')).toBe('🌙');
  });

  it('reads Arabic without mangling it', () => {
    // Caseless, so `toUpperCase` must leave the letter exactly as it was.
    expect(initials('علي حسن')).toBe('عح');
    expect(initials('منى')).toBe('م');
  });

  it('collapses the whitespace a pasted name arrives with', () => {
    expect(initials('  Ali   Hassan  ')).toBe('AH');
    expect(initials('Ali\tHassan')).toBe('AH');
  });
});
