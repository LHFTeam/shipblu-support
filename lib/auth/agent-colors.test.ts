import { describe, expect, it } from 'vitest';
import { AGENT_COLORS, agentColorClass } from './agent-colors';

describe('agentColorClass', () => {
  it('draws every stored colour as a solid fill with white initials', () => {
    const classes = AGENT_COLORS.map(agentColorClass);
    expect(new Set(classes).size).toBe(AGENT_COLORS.length);
    for (const cls of classes) expect(cls).toMatch(/^bg-\S+ text-white$/);
  });

  it('falls back to the first colour for a row the trigger has not reached, or a retired key', () => {
    expect(agentColorClass(null)).toBe(agentColorClass(AGENT_COLORS[0]));
    expect(agentColorClass('teal')).toBe(agentColorClass(AGENT_COLORS[0]));
  });
});
