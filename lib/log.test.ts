import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('prints the tag, the message and each field that has a value', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger('send_whatsapp').info('sent', { messageId: 'm-1', attempt: 2, skipped: undefined });

    expect(out).toHaveBeenCalledWith('[send_whatsapp] sent messageId=m-1 attempt=2');
  });

  it('prints a line with no fields exactly as the message was written', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger('presence_sweep').info('both windows are off, nothing to do');

    expect(out).toHaveBeenCalledWith('[presence_sweep] both windows are off, nothing to do');
  });

  // The console arguments, not only the text: `console.error(line, error)` is
  // what prints the stack, and a migration must not turn it into one string.
  it('hands the caught value to the console as its own argument', () => {
    const out = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('connection reset');

    logger('worker').error('fatal', error);

    expect(out).toHaveBeenCalledWith('[worker] fatal', error);
  });

  it('passes no second argument when there is no error', () => {
    const out = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logger('whatsapp').warn('account errors on e-1: bad token');

    expect(out.mock.calls).toEqual([['[whatsapp] account errors on e-1: bad token']]);
  });

  it('reaches a spy installed after the logger was made', () => {
    const log = logger('cleanup');
    const out = vi.spyOn(console, 'error').mockImplementation(() => {});

    log.error('failed');

    expect(out).toHaveBeenCalledWith('[cleanup] failed');
  });
});
