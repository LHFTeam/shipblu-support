import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { conversationTopic, queueTopic } from '@/lib/realtime/topics';

const producer = readFileSync(
  new URL('./001_extensions_and_triggers.sql', import.meta.url),
  'utf8',
);

/**
 * The same file with `--` comments removed, so an assertion about what the SQL
 * *does* cannot be satisfied or broken by what the SQL *says*.
 * `scripts/ci/repo-rules.mjs` strips the same way before asserting on this file.
 */
const code = producer.replace(/--[^\n]*/g, '');

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

  it('emits no global topic, so one write cannot wake every browser', () => {
    // The regression §6.23 was about: a single `conversation_changed` reaching
    // every console and widget turned one message insert into a full inbox
    // render everywhere. It was kept for one deploy window after that and is
    // now gone.
    //
    // Asserted positively — every NOTIFY in the file must be one of the two
    // scoped forms — rather than by forbidding the old name. Forbidding a
    // literal fails at both ends: `pg_notify('inbox_changed', payload)` would
    // reintroduce the exact regression while passing, and a future author who
    // documents the removal by quoting the old statement in a comment would
    // turn this red with no behaviour change.
    //
    // Comments are stripped first, the same way scripts/ci/repo-rules.mjs does
    // it for this file, so the prose above the trigger can keep explaining what
    // was removed and why.
    const statements = code.match(/pg_notify\(\s*[^)]*/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);

    for (const call of statements) {
      // A scoped topic is built from a prefix and an id, never a bare literal
      // that every listener could subscribe to. `job_enqueued` is the worker's
      // own queue wake-up, which is process-to-process and fans out to one
      // consumer rather than to every open browser.
      expect(call).toMatch(/'conversation_' \|\||'conversation_queue_' \|\||'job_enqueued'/);
    }
  });
});
