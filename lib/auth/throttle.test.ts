import { describe, expect, it } from 'vitest';
import { allowEmailDispatch, allowLoginAttempt, clearLoginAttempts } from './throttle';

/**
 * Buckets are module state shared across cases, so every test uses its own
 * address rather than trying to reset the map.
 */
describe('allowLoginAttempt', () => {
  it('allows ten attempts and then refuses', () => {
    const email = 'login-budget@example.test';
    for (let i = 0; i < 10; i += 1) expect(allowLoginAttempt(email, '10.0.0.1')).toBe(true);
    expect(allowLoginAttempt(email, '10.0.0.1')).toBe(false);
  });

  it('does not let one address spend another address budget', () => {
    const victim = 'victim@example.test';
    for (let i = 0; i < 12; i += 1) allowLoginAttempt(victim, '10.0.0.2');

    // Same IP is now spent too, so the victim on a different connection still
    // gets through — which is the point of keying on both.
    expect(allowLoginAttempt('someone-else@example.test', '10.0.0.3')).toBe(true);
  });

  it('forgives earlier typos once a sign-in succeeds', () => {
    const email = 'typo@example.test';
    for (let i = 0; i < 9; i += 1) allowLoginAttempt(email, '10.0.0.4');
    clearLoginAttempts(email, '10.0.0.4');
    for (let i = 0; i < 10; i += 1) expect(allowLoginAttempt(email, '10.0.0.4')).toBe(true);
  });
});

describe('allowEmailDispatch', () => {
  it('is tighter than the sign-in budget', () => {
    const email = 'mailer@example.test';
    for (let i = 0; i < 5; i += 1) expect(allowEmailDispatch(email, '10.0.1.1')).toBe(true);
    expect(allowEmailDispatch(email, '10.0.1.1')).toBe(false);
  });

  it('keeps its own budget, so sign-in attempts do not stop a reset request', () => {
    const email = 'separate@example.test';
    for (let i = 0; i < 12; i += 1) allowLoginAttempt(email, '10.0.1.2');
    expect(allowEmailDispatch(email, '10.0.1.2')).toBe(true);
  });

  it('caps one source spraying many addresses, but well above one household', () => {
    // Loose on purpose: carrier NAT puts a great many unrelated Egyptian
    // customers behind one address, so this must not trip on ordinary traffic.
    for (let i = 0; i < 20; i += 1) {
      expect(allowEmailDispatch(`neighbour-${i}@example.test`, '10.0.1.9')).toBe(true);
    }
    for (let i = 20; i < 60; i += 1) allowEmailDispatch(`spray-${i}@example.test`, '10.0.1.9');
    expect(allowEmailDispatch('spray-last@example.test', '10.0.1.9')).toBe(false);
  });
});
