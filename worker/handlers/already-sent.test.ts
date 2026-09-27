import { describe, expect, it, vi } from 'vitest';
import { alreadySent } from './already-sent';

describe('alreadySent', () => {
  it.each(['pending', 'failed'] as const)('sends a message that is %s', (status) => {
    expect(alreadySent('send_email', 'message-1', status)).toBe(false);
  });

  it.each(['sent', 'delivered', 'read', 'bounced'] as const)(
    'skips a message that is already %s, and says so',
    (status) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      expect(alreadySent('send_email', 'message-1', status)).toBe(true);
      expect(log).toHaveBeenCalledWith(`[send_email] message-1 is ${status}, skipping`);

      log.mockRestore();
    },
  );
});
