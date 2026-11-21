import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one rule for the myBlu credentials (`./secrets`). Loaded afresh for each
 * test, since what it has already warned about is held for the process.
 */

const load = () => import('./secrets');
const LONG = 'k'.repeat(32);

describe('usableSecret', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers the value without its surrounding whitespace', async () => {
    const { usableSecret } = await load();
    expect(usableSecret('MYBLU_WEBHOOK_SECRET', `  ${LONG}\n`)).toBe(LONG);
    expect(usableSecret('MYBLU_API_TOKEN', LONG)).toBe(LONG);
  });

  it('counts unset, blank and short values as unset, and judges a value by what is left once trimmed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { usableSecret } = await load();
    expect(usableSecret('A', undefined)).toBeNull();
    expect(usableSecret('A', ' \n')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    // Thirty-one characters and a newline is thirty-two bytes, and short.
    expect(usableSecret('MYBLU_WEBHOOK_SECRET_PREVIOUS', `${'k'.repeat(31)}\n`)).toBeNull();
  });

  // A previous secret cut off when pasted was dropped without a word, and a
  // rotation the receiver had not followed failed every delivery for a day.
  it('names a short value once, and never its value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { usableSecret } = await load();
    const short = 'cut-off-secret-value';

    usableSecret('MYBLU_WEBHOOK_SECRET_PREVIOUS', short);
    usableSecret('MYBLU_WEBHOOK_SECRET_PREVIOUS', short);
    usableSecret('MYBLU_API_TOKEN_PREVIOUS', short);

    const lines = warn.mock.calls.map((call) => call.map(String).join(' '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('MYBLU_WEBHOOK_SECRET_PREVIOUS is shorter than 32 characters');
    expect(lines[1]).toContain('MYBLU_API_TOKEN_PREVIOUS is shorter than 32 characters');
    expect(lines.join('\n')).not.toContain(short);
  });
});
