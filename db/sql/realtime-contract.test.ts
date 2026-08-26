import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { conversationTopic, queueTopic } from '@/lib/realtime/topics';

const producer = readFileSync(
  new URL('./001_extensions_and_triggers.sql', import.meta.url),
  'utf8',
);

/**
 * Contract tests at the TypeScript/PL/pgSQL boundary.
 *
 * There is intentionally no second implementation of the trigger in test code.
 * These assertions pin the topic names the browser listens to and the semantic
 * distinction that caused the incident: an insert changes the queue; a delivery
 * update changes only the open conversation.
 */
describe('realtime SQL producer contract', () => {
  it('uses the same channel and conversation topic formats as TypeScript', () => {
    expect(queueTopic('whatsapp')).toBe('conversation_queue_whatsapp');
    expect(producer).toContain("pg_notify('conversation_queue_' || conversation_channel, payload)");

    expect(conversationTopic('f58a1b9c-8c8b-45d7-9e53-7db89d222d28')).toBe(
      'conversation_f58a1b9c8c8b45d79e537db89d222d28',
    );
    expect(producer).toContain("'conversation_' || replace(conversation_id::text, '-', '')");
  });

  it('does not treat a message delivery update as a queue change', () => {
    expect(producer).toMatch(
      /IF TG_TABLE_NAME = 'messages' THEN\s+queue_relevant := TG_OP = 'INSERT';/,
    );
  });

  it('keeps the old global topic only as a documented deploy compatibility path', () => {
    expect(producer).toContain('Compatibility for the old app instance/client bundle');
    expect(producer).toContain("pg_notify('conversation_changed', payload)");
  });
});
