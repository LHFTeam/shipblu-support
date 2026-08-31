import { describe, expect, it } from 'vitest';
import { initialView } from './view';

describe('initialView', () => {
  it('opens on the questions for a visitor with nothing to come back to', () => {
    expect(initialView({ messageCount: 0 })).toBe('home');
  });

  it('opens on the conversation when there is one', () => {
    // The case that is hardest to reproduce by hand and worst to get wrong:
    // burying an agent's reply under the FAQ list the visitor already skipped.
    expect(initialView({ messageCount: 2 })).toBe('thread');
  });
});
