import { describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { priorityAiMinProbability, priorityAiMode } from './settings';

/**
 * The switch is read on every ingest path, so the one property worth a test is
 * that a value nobody meant turns the feature off rather than on — or throws.
 */

withTestEnv();

describe('priorityAiMode', () => {
  it('is off when unset', () => {
    expect(priorityAiMode()).toBe('off');
  });

  it('reads the three modes, forgiving case and spaces', () => {
    setTestEnv({ PRIORITY_AI: ' Shadow ' });
    expect(priorityAiMode()).toBe('shadow');
    setTestEnv({ PRIORITY_AI: 'apply' });
    expect(priorityAiMode()).toBe('apply');
  });

  it('reads anything else as off, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTestEnv({ PRIORITY_AI: 'true' });
    expect(priorityAiMode()).toBe('off');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('warns about one bad value once, not on every message read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTestEnv({ PRIORITY_AI: 'yes' });
    priorityAiMode();
    priorityAiMode();
    expect(warn).toHaveBeenCalledOnce();
    setTestEnv({ PRIORITY_AI: 'on' });
    expect(priorityAiMode()).toBe('off');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('priorityAiMinProbability', () => {
  it('defaults when unset', () => {
    expect(priorityAiMinProbability()).toBe(0.6);
  });

  it('reads a number in 0..1', () => {
    setTestEnv({ PRIORITY_AI_MIN_PROBABILITY: '0.8' });
    expect(priorityAiMinProbability()).toBe(0.8);
  });

  it('falls back on a percentage typed as one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTestEnv({ PRIORITY_AI_MIN_PROBABILITY: '80' });
    expect(priorityAiMinProbability()).toBe(0.6);
    warn.mockRestore();
  });

  it('reads a value pasted with spaces as unset, not as a threshold of zero', () => {
    // `Number(' ')` is 0, which would apply every answer the model gave.
    setTestEnv({ PRIORITY_AI_MIN_PROBABILITY: ' ' });
    expect(priorityAiMinProbability()).toBe(0.6);
    setTestEnv({ PRIORITY_AI_MIN_PROBABILITY: ' 0.8\n' });
    expect(priorityAiMinProbability()).toBe(0.8);
  });
});
