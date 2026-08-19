import { describe, expect, it } from 'vitest';
import type { SessionAgent } from '@/lib/auth/session';
import {
  canSeeChannel,
  hiddenChannels,
  isReadOnlyChannel,
  isRestrictedChannel,
  readOnlyChannels,
  readOnlyReason,
} from './channel-policy';

function agent(role: SessionAgent['role'], permissions: Record<string, boolean> = {}) {
  return { role, permissions } as SessionAgent;
}

describe('read-only channels', () => {
  it('covers the customer bot and nothing the team works', () => {
    expect(isReadOnlyChannel('whatsapp_bot')).toBe(true);
    for (const channel of ['whatsapp', 'email', 'webchat', 'facebook', 'instagram']) {
      expect(isReadOnlyChannel(channel)).toBe(false);
    }
  });

  it('gives a reason for the channel it refuses, and none for the others', () => {
    expect(readOnlyReason('whatsapp_bot')).toMatch(/customer bot/i);
    expect(readOnlyReason('whatsapp')).toBeNull();
  });

  it('lists itself for excluding from a query', () => {
    expect(readOnlyChannels()).toEqual(['whatsapp_bot']);
  });
});

describe('who can see the bot channel', () => {
  it('is hidden from agents and supervisors', () => {
    for (const role of ['agent', 'supervisor'] as const) {
      expect(hiddenChannels(agent(role))).toEqual(['whatsapp_bot']);
      expect(canSeeChannel(agent(role), 'whatsapp_bot')).toBe(false);
      // Everything else stays visible: the exclusion must not become a
      // general-purpose filter that quietly narrows the inbox.
      expect(canSeeChannel(agent(role), 'whatsapp')).toBe(true);
    }
  });

  it('is visible to admins', () => {
    for (const role of ['admin', 'account_admin'] as const) {
      expect(hiddenChannels(agent(role))).toEqual([]);
      expect(canSeeChannel(agent(role), 'whatsapp_bot')).toBe(true);
    }
  });

  it('can be granted to one supervisor without promoting them', () => {
    const trusted = agent('supervisor', { 'ticket.view.bot': true });
    expect(canSeeChannel(trusted, 'whatsapp_bot')).toBe(true);
    expect(hiddenChannels(trusted)).toEqual([]);
  });

  it('can be taken away from an admin', () => {
    const restricted = agent('admin', { 'ticket.view.bot': false });
    expect(canSeeChannel(restricted, 'whatsapp_bot')).toBe(false);
  });

  it('is restricted and read-only independently of each other', () => {
    // Two separate questions that happen to have the same answer today. A
    // channel could be one without the other, and the callers ask for the one
    // they mean.
    expect(isRestrictedChannel('whatsapp_bot')).toBe(true);
    expect(isRestrictedChannel('whatsapp')).toBe(false);
  });
});
