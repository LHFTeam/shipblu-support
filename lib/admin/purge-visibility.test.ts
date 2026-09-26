import { describe, expect, it } from 'vitest';
import type { SessionAgent } from '@/lib/auth/session';
import { unseenChannels } from './purge-visibility';

function agent(role: SessionAgent['role'], permissions: Record<string, boolean> = {}) {
  return { role, permissions } as SessionAgent;
}

describe('unseenChannels', () => {
  it('names the bot channel for an admin whose override removed ticket.view.bot', () => {
    // The case the check exists for: `ticket.purge` without the channel. An
    // admin holds both by default, so without an override nothing is hidden.
    const restricted = agent('admin', { 'ticket.view.bot': false });
    expect(unseenChannels(restricted, ['email', 'whatsapp_bot', 'whatsapp'])).toEqual([
      'whatsapp_bot',
    ]);
  });

  it('names nothing when the admin can see every channel', () => {
    expect(unseenChannels(agent('admin'), ['email', 'whatsapp_bot'])).toEqual([]);
  });

  it('names nothing when every ticket in scope is on a visible channel', () => {
    const restricted = agent('admin', { 'ticket.view.bot': false });
    expect(unseenChannels(restricted, ['email', 'instagram', 'webchat'])).toEqual([]);
  });

  it('names a hidden channel once however many tickets sit on it', () => {
    const restricted = agent('admin', { 'ticket.view.bot': false });
    expect(unseenChannels(restricted, ['whatsapp_bot', 'email', 'whatsapp_bot'])).toEqual([
      'whatsapp_bot',
    ]);
  });

  it('names nothing for an empty scope', () => {
    expect(unseenChannels(agent('agent'), [])).toEqual([]);
  });
});
