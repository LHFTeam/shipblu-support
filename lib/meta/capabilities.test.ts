import { describe, expect, it } from 'vitest';
import { CAPABILITIES, diagnoseCapabilities, requiredScopes } from './capabilities';
import type { MetaConnection } from './connection';

const PAGE_IG_DM = 'Instagram direct messages (Facebook Page connection)';
const PAGE_IG_COMMENTS = 'Instagram comment webhooks and moderation (Facebook Page connection)';
const DIRECT_IG_DM = 'Instagram direct messages (direct connection)';

function report(
  scopes: string[],
  declined: string[] = [],
  connection: MetaConnection = 'facebook_page',
) {
  const byName = new Map(
    diagnoseCapabilities(scopes, declined, connection).map((entry) => [
      entry.capability.name,
      entry,
    ]),
  );
  return byName;
}

describe('diagnoseCapabilities', () => {
  it('reproduces the live split: Instagram DMs work, Instagram comments do not', () => {
    // Exactly what the `permissions` webhooks recorded on 2026-08-29, which is
    // the case this module was written for.
    const entries = report(['instagram_basic', 'instagram_manage_messages']);

    expect(entries.get(PAGE_IG_DM)?.blocked).toBe(false);

    const comments = entries.get(PAGE_IG_COMMENTS);
    expect(comments?.blocked).toBe(true);
    expect(
      comments?.permissions.filter((p) => p.status !== 'granted').map((p) => p.permission),
    ).toEqual([
      'instagram_manage_comments',
      'pages_manage_metadata',
      'pages_read_engagement',
      'pages_show_list',
    ]);
  });

  it('separates a permission nobody asked for from one somebody unticked', () => {
    // Different fixes: declined is re-authorising, missing is changing what the
    // authorisation asks for first.
    const entries = report(['instagram_basic'], ['instagram_manage_comments']);
    const comments = entries.get(PAGE_IG_COMMENTS);

    expect(
      comments?.permissions.find((p) => p.permission === 'instagram_manage_comments')?.status,
    ).toBe('declined');
    expect(
      comments?.permissions.find((p) => p.permission === 'pages_read_engagement')?.status,
    ).toBe('missing');
  });

  it('clears every capability when the full scope list is granted', () => {
    for (const connection of ['facebook_page', 'instagram_login'] as const) {
      const entries = diagnoseCapabilities(requiredScopes(connection), [], connection);
      expect(entries.filter((entry) => entry.blocked)).toEqual([]);
    }
  });

  /*
    The report is per connection, and this is the property that makes it worth
    reading at all.

    An app connected both ways holds two authorisations with two vocabularies:
    the Page token carries `instagram_manage_comments` and is *supposed* to lack
    `instagram_business_manage_comments`, and the Instagram token the reverse.
    Judging one token against the whole table reports a correct configuration as
    half blocked, which is how a diagnostic stops being read.
  */
  it('judges a token only against its own connection', () => {
    const pageEntries = report(requiredScopes('facebook_page'));
    expect(pageEntries.has(DIRECT_IG_DM)).toBe(false);
    expect(pageEntries.get(PAGE_IG_DM)?.blocked).toBe(false);

    const directEntries = report(requiredScopes('instagram_login'), [], 'instagram_login');
    expect(directEntries.has(PAGE_IG_DM)).toBe(false);
    expect(directEntries.get(DIRECT_IG_DM)?.blocked).toBe(false);
  });

  it('names the direct connection permissions in their own spelling', () => {
    // `instagram_business_*`, not `instagram_*`. Requesting the wrong set is an
    // App Review submission against a flow nothing uses.
    expect(requiredScopes('instagram_login')).toEqual([
      'instagram_business_basic',
      'instagram_business_manage_comments',
      'instagram_business_manage_messages',
    ]);
  });

  it('warns that Instagram comments need Advanced Access even when fully granted', () => {
    // The trap this flag exists for: every permission granted, and Meta still
    // delivers nothing until App Review approves it.
    const entries = report(requiredScopes());
    const comments = entries.get(PAGE_IG_COMMENTS);

    expect(comments?.blocked).toBe(false);
    expect(comments?.capability.advancedAccess).toContain('Advanced Access');

    // The rows that are genuinely satisfied by a grant alone must not carry it,
    // or the warning stops meaning anything.
    expect(entries.get(PAGE_IG_DM)?.capability.advancedAccess).toBeUndefined();
    expect(entries.get('Messenger direct messages')?.capability.advancedAccess).toBeUndefined();
  });

  it('covers every permission the table names in the scope list to request', () => {
    for (const capability of CAPABILITIES) {
      for (const permission of capability.permissions) {
        expect(requiredScopes(capability.connection)).toContain(permission);
      }
    }
  });

  it("keeps the two connections' scope lists disjoint", () => {
    // Not an accident to preserve for tidiness: a permission in both lists would
    // be requested from whichever authorisation ran last and reported granted on
    // the other, which is precisely the confusion the split exists to end.
    const page = new Set(requiredScopes('facebook_page'));
    const direct = requiredScopes('instagram_login');

    expect(direct.filter((permission) => page.has(permission))).toEqual([]);
  });
});
