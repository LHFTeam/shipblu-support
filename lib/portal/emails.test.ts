import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { passwordResetEmail, verificationEmail } from './emails';

/**
 * The links are the whole content of these emails, so that is what is pinned:
 * the hostname a customer is sent to, the locale segment, and the token.
 */
const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.KB_PUBLIC_HOST = 'support.shipblu.com';
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('verificationEmail', () => {
  it('links to the help centre hostname, not the Render URL', () => {
    process.env.APP_URL = 'https://shipblu-support.onrender.com';

    const email = verificationEmail('ar', 'tok-123');

    expect(email.textBody).toContain('https://support.shipblu.com/ar/account/verify/tok-123');
    expect(email.textBody).not.toContain('onrender.com');
    expect(email.htmlBody).toContain('https://support.shipblu.com/ar/account/verify/tok-123');
  });

  it('falls back to APP_URL before the custom domain exists', () => {
    delete process.env.KB_PUBLIC_HOST;
    process.env.APP_URL = 'https://shipblu-support.onrender.com';

    expect(verificationEmail('en', 'tok').textBody).toContain(
      'https://shipblu-support.onrender.com/en/account/verify/tok',
    );
  });

  it('is written in the language the customer was reading', () => {
    expect(verificationEmail('ar', 'tok').subject).toContain('شيب بلو');
    expect(verificationEmail('en', 'tok').subject).toContain('ShipBlu');
    expect(verificationEmail('ar', 'tok').htmlBody).toContain('dir="rtl"');
    expect(verificationEmail('en', 'tok').htmlBody).toContain('dir="ltr"');
  });

  it('percent-encodes a token so a stray character cannot break the URL', () => {
    expect(verificationEmail('en', 'a/b+c').textBody).toContain('/verify/a%2Fb%2Bc');
  });
});

describe('passwordResetEmail', () => {
  it('points at the reset page rather than the verification one', () => {
    const email = passwordResetEmail('en', 'tok-456');

    expect(email.textBody).toContain('https://support.shipblu.com/en/account/reset/tok-456');
    expect(email.textBody).not.toContain('/account/verify/');
  });

  it('says the current password is unchanged, in both languages', () => {
    // The sentence that stops a reset email nobody asked for reading as a
    // break-in notice.
    expect(passwordResetEmail('en', 'tok').textBody).toContain('current password is unchanged');
    expect(passwordResetEmail('ar', 'tok').textBody).toContain('كلمة مرورك الحالية لم تتغير');
  });
});
