import { describe, expect, it } from 'vitest';
import { CAPABILITIES, diagnoseCapabilities, requiredScopes } from './capabilities';

function report(scopes: string[], declined: string[] = []) {
  const byName = new Map(
    diagnoseCapabilities(scopes, declined).map((entry) => [entry.capability.name, entry]),
  );
  return byName;
}

describe('diagnoseCapabilities', () => {
  it('reproduces the live split: Instagram DMs work, Instagram comments do not', () => {
    // Exactly what the `permissions` webhooks recorded on 2026-08-29, which is
    // the case this module was written for.
    const entries = report(['instagram_basic', 'instagram_manage_messages']);

    expect(entries.get('Instagram direct messages')?.blocked).toBe(false);

    const comments = entries.get('Instagram comment webhooks and moderation');
    expect(comments?.blocked).toBe(true);
    expect(
      comments?.permissions.filter((p) => p.status !== 'granted').map((p) => p.permission),
    ).toEqual(['instagram_manage_comments', 'pages_read_engagement', 'pages_show_list']);
  });

  it('separates a permission nobody asked for from one somebody unticked', () => {
    // Different fixes: declined is re-authorising, missing is changing what the
    // authorisation asks for first.
    const entries = report(['instagram_basic'], ['instagram_manage_comments']);
    const comments = entries.get('Instagram comment webhooks and moderation');

    expect(
      comments?.permissions.find((p) => p.permission === 'instagram_manage_comments')?.status,
    ).toBe('declined');
    expect(
      comments?.permissions.find((p) => p.permission === 'pages_read_engagement')?.status,
    ).toBe('missing');
  });

  it('clears every capability when the full scope list is granted', () => {
    const entries = diagnoseCapabilities(requiredScopes());
    expect(entries.filter((entry) => entry.blocked)).toEqual([]);
  });

  it('covers every permission the table names in the scope list to request', () => {
    for (const capability of CAPABILITIES) {
      for (const permission of capability.permissions) {
        expect(requiredScopes()).toContain(permission);
      }
    }
  });
});
