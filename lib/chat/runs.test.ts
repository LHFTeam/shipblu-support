import { describe, expect, it } from 'vitest';
import { runPositions } from './runs';

describe('runPositions', () => {
  it('answers nothing for an empty thread', () => {
    expect(runPositions([])).toEqual([]);
  });

  it('leaves a lone message single', () => {
    expect(runPositions(['customer'])).toEqual(['single']);
  });

  it('joins consecutive messages from one sender', () => {
    expect(runPositions(['a', 'a', 'a', 'b', 'b', 'a'])).toEqual([
      'first',
      'middle',
      'last',
      'first',
      'last',
      'single',
    ]);
  });

  it('breaks a run on both sides of something that is not a bubble', () => {
    // A day break between two of Mariam's messages starts a new block, even
    // though the sender did not change.
    expect(runPositions(['mariam', null, 'mariam', 'mariam'])).toEqual([
      'single',
      'single',
      'first',
      'last',
    ]);
  });

  it('never joins two non-bubbles to each other', () => {
    expect(runPositions([null, null])).toEqual(['single', 'single']);
  });

  it('reads the key through a function when given items', () => {
    const messages = [
      { from: 'agent', author: 'Mariam' },
      { from: 'agent', author: 'Mariam' },
      { from: 'agent', author: 'Karim' },
      { from: 'visitor', author: null },
    ];

    expect(runPositions(messages, (m) => `${m.from}:${m.author ?? ''}`)).toEqual([
      'first',
      'last',
      'single',
      'single',
    ]);
  });
});
