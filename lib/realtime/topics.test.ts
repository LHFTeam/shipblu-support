import { describe, expect, it } from 'vitest';
import type { SessionAgent } from '@/lib/auth/session';
import { conversationTopic, parseQueueChannel, queueTopic, queueTopicsForAgent } from './topics';

function agent(role: SessionAgent['role'], permissions: Record<string, boolean> = {}) {
  return { role, permissions } as SessionAgent;
}

describe('queue topics', () => {
  it('routes the working queue to every non-restricted database channel', () => {
    expect(queueTopicsForAgent(agent('agent'), 'all')).toEqual([
      'conversation_queue_email',
      'conversation_queue_whatsapp',
      'conversation_queue_webchat',
      'conversation_queue_facebook',
      'conversation_queue_instagram',
      'conversation_queue_portal',
      'conversation_queue_api',
      'conversation_queue_mobile',
    ]);
  });

  it('keeps restricted traffic opt-in even for an admin', () => {
    expect(queueTopicsForAgent(agent('admin'), 'all')).not.toContain(
      'conversation_queue_whatsapp_bot',
    );
    expect(queueTopicsForAgent(agent('admin'), 'whatsapp_bot')).toEqual([
      'conversation_queue_whatsapp_bot',
    ]);
  });

  it('refuses a restricted subscription without its permission', () => {
    expect(queueTopicsForAgent(agent('agent'), 'whatsapp_bot')).toBeNull();
    expect(
      queueTopicsForAgent(agent('supervisor', { 'ticket.view.bot': true }), 'whatsapp_bot'),
    ).toEqual(['conversation_queue_whatsapp_bot']);
  });

  it('parses only known queue channels and defaults an omitted value to all', () => {
    expect(parseQueueChannel(null)).toBe('all');
    expect(parseQueueChannel('portal')).toBe('portal');
    expect(parseQueueChannel('made_up')).toBeNull();
  });

  it('uses the same queue prefix as the SQL producer', () => {
    expect(queueTopic('email')).toBe('conversation_queue_email');
  });
});

describe('conversation topics', () => {
  it('turns a UUID into a bounded PostgreSQL identifier', () => {
    expect(conversationTopic('F58A1B9C-8C8B-45D7-9E53-7DB89D222D28')).toBe(
      'conversation_f58a1b9c8c8b45d79e537db89d222d28',
    );
  });

  it('refuses arbitrary LISTEN identifiers', () => {
    expect(conversationTopic('not-a-uuid')).toBeNull();
    expect(conversationTopic('abc"; listen conversation_changed; --')).toBeNull();
  });
});
