import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalEmailProvider } from './local';

const provider = new LocalEmailProvider({ acceptInbound: true });
const payload = { from: { address: 'amira@customer.example' }, textBody: 'Hello?' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LocalEmailProvider.parseInbound', () => {
  it('reads dateHeader as the claim it simulates, and a malformed one as absent', async () => {
    const skewed = await provider.parseInbound({
      ...payload,
      dateHeader: 'Sun, 20 Sep 2026 08:30:00 +0300',
    });
    expect(skewed.dateHeader).toEqual(new Date('2026-09-20T08:30:00+03:00'));

    expect((await provider.parseInbound({ ...payload, dateHeader: 'soon' })).dateHeader).toBeNull();
    expect((await provider.parseInbound(payload)).dateHeader).toBeNull();
  });

  // The driver used to honour it, so a payload written then would now be stamped
  // with its arrival without a word. It is warned about rather than refused:
  // the mail still lands, just not backdated.
  it('warns about a receivedAt it no longer honours, and does not pass it on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = await provider.parseInbound({ ...payload, receivedAt: '2026-09-01T10:00:00Z' });

    expect(parsed).not.toHaveProperty('receivedAt');
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[email:local\] ignoring receivedAt/),
    );
  });

  // Ingest's idempotency is keyed on the id, and a retried job parses the same
  // stored payload again: a clock-minted id stored the mail twice.
  it('derives a missing Message-ID from the payload, so a re-parse agrees', async () => {
    const first = await provider.parseInbound(payload);
    const again = await provider.parseInbound(payload);
    const different = await provider.parseInbound({ ...payload, textBody: 'Anyone?' });

    expect(first.messageId).toMatch(/^local-[0-9a-f]{32}@localhost$/);
    expect(again.messageId).toBe(first.messageId);
    expect(different.messageId).not.toBe(first.messageId);
  });
});
