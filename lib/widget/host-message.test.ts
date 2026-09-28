import { describe, expect, it } from 'vitest';
import { isFromHost } from './host-message';
import { SOURCE } from './protocol';

/**
 * The widget frame deciding whether a message is its host page speaking. The
 * case the origin check alone let through is a second frame on the host page,
 * served from an allowed origin: same origin, right tag, wrong window.
 */

const parent = { name: 'the host page' };
const sibling = { name: 'another frame on the host page' };

const frame = {
  parent,
  ownOrigin: 'https://support.shipblu.test',
  hostOrigins: ['https://dashboard.shipblu.test'],
};

function event(overrides: Partial<{ origin: string; source: unknown; data: unknown }> = {}) {
  return {
    origin: 'https://dashboard.shipblu.test',
    source: parent,
    data: { source: SOURCE.host, type: 'opened' },
    ...overrides,
  };
}

describe('isFromHost', () => {
  it('accepts the parent window, on an allowed origin, with the host tag', () => {
    expect(isFromHost(event(), frame)).toBe(true);
  });

  it('accepts our own origin, which is the help centre framing itself', () => {
    expect(isFromHost(event({ origin: 'https://support.shipblu.test' }), frame)).toBe(true);
  });

  it('refuses another frame on the host page, even from an allowed origin', () => {
    expect(isFromHost(event({ source: sibling }), frame)).toBe(false);
  });

  it('refuses a message with no source window', () => {
    expect(isFromHost(event({ source: null }), frame)).toBe(false);
  });

  it('refuses an origin that is not allowed, whatever window sent it', () => {
    expect(isFromHost(event({ origin: 'https://evil.test' }), frame)).toBe(false);
  });

  it('refuses the right window without the host tag', () => {
    expect(isFromHost(event({ data: { type: 'opened' } }), frame)).toBe(false);
    expect(isFromHost(event({ data: null }), frame)).toBe(false);
    expect(isFromHost(event({ data: 'opened' }), frame)).toBe(false);
  });
});
