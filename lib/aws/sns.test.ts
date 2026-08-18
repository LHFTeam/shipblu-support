import { describe, expect, it } from 'vitest';
import { isTrustedCertUrl } from './sns';

/**
 * The certificate URL check is the whole security of SNS verification: without
 * it an attacker posts a message naming their own certificate and every
 * signature verifies.
 */
describe('isTrustedCertUrl', () => {
  it('accepts Amazon regional SNS hosts', () => {
    expect(
      isTrustedCertUrl('https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem'),
    ).toBe(true);
    expect(
      isTrustedCertUrl('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-x.pem'),
    ).toBe(true);
    expect(
      isTrustedCertUrl('https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-x.pem'),
    ).toBe(true);
  });

  it('rejects a lookalike host that merely ends with the Amazon domain', () => {
    expect(isTrustedCertUrl('https://sns.eu-central-1.amazonaws.com.evil.test/cert.pem')).toBe(
      false,
    );
    expect(isTrustedCertUrl('https://evil.test/sns.eu-central-1.amazonaws.com/cert.pem')).toBe(
      false,
    );
    expect(isTrustedCertUrl('https://notsns.eu-central-1.amazonaws.com/cert.pem')).toBe(false);
  });

  it('rejects a host that puts the Amazon domain in userinfo', () => {
    expect(isTrustedCertUrl('https://sns.eu-central-1.amazonaws.com@evil.test/cert.pem')).toBe(
      false,
    );
  });

  it('requires https', () => {
    expect(isTrustedCertUrl('http://sns.eu-central-1.amazonaws.com/cert.pem')).toBe(false);
  });

  it('requires a .pem path', () => {
    expect(isTrustedCertUrl('https://sns.eu-central-1.amazonaws.com/cert.txt')).toBe(false);
  });

  it('rejects junk instead of throwing', () => {
    expect(isTrustedCertUrl('not a url')).toBe(false);
    expect(isTrustedCertUrl('')).toBe(false);
  });
});
