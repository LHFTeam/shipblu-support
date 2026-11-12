import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { senderAddress } from './sender';

/**
 * The sender is checked where mail is sent from it, never in `env()`: a value
 * that fails the check fails the sends that need it, and every service still
 * starts (§6.117, and `docs/PROJECT-STATE.md` §2 for why `env()` holds no
 * format rule).
 */

withTestEnv({ APP_SECRET: '0'.repeat(64), EMAIL_FROM_ADDRESS: 'help-support@shipblu.com' });

describe('senderAddress', () => {
  it('hands back a sender the provider takes', () => {
    expect(senderAddress()).toBe('help-support@shipblu.com');
  });

  it('refuses one the provider would not, naming the variable, while env() still parses', () => {
    setTestEnv({ EMAIL_FROM_ADDRESS: 'help..support@shipblu.com' });

    expect(() => env()).not.toThrow();
    expect(() => senderAddress()).toThrow(
      'EMAIL_FROM_ADDRESS is not an email address the provider takes',
    );
  });

  it('says so when there is none', () => {
    setTestEnv({ EMAIL_FROM_ADDRESS: undefined });

    expect(() => senderAddress()).toThrow('EMAIL_FROM_ADDRESS is not configured');
  });
});
