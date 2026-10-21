import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { withTestEnv } from '@/lib/testing/env';
import { liveConversationFilter, type ThreadKey } from './live-conversation';

/**
 * The conditions WhatsApp and the widget used to write out separately,
 * read back as SQL. No database: building a query validates the environment but
 * never opens a connection.
 */
withTestEnv();

function statement(key: ThreadKey) {
  return db
    .select({ id: conversations.id })
    .from(conversations)
    .where(liveConversationFilter('contact-1', key))
    .toSQL();
}

describe('liveConversationFilter', () => {
  it('is the requester, the channel, neither deleted nor merged away, and not an import', () => {
    const { sql, params } = statement({ channel: 'webchat' });

    expect(sql).toContain(
      'where ("conversations"."requester_contact_id" = $1 and "conversations"."channel" = $2 ' +
        'and "conversations"."deleted_at" is null and "conversations"."merged_into_id" is null ' +
        'and "conversations"."source_system" <> $3)',
    );
    expect(params).toEqual(['contact-1', 'webchat', 'import']);
  });

  // The bot has one number, so its key is the person alone — the statement it
  // ran before WhatsApp threaded on the number, unchanged.
  it('keys the bot on the person alone', () => {
    const { sql, params } = statement({ channel: 'whatsapp_bot' });

    expect(sql).toContain(
      'where ("conversations"."requester_contact_id" = $1 and "conversations"."channel" = $2 ' +
        'and "conversations"."deleted_at" is null and "conversations"."merged_into_id" is null ' +
        'and "conversations"."source_system" <> $3)',
    );
    expect(sql).not.toContain('channel_id');
    expect(params).toEqual(['contact-1', 'whatsapp_bot', 'import']);
  });

  it('keys WhatsApp on our number too', () => {
    const { sql, params } = statement({ channel: 'whatsapp', channelId: 'row-a' });

    expect(sql).toContain(
      'where ("conversations"."requester_contact_id" = $1 and "conversations"."channel" = $2 ' +
        'and "conversations"."channel_id" = $3 ' +
        'and "conversations"."deleted_at" is null and "conversations"."merged_into_id" is null ' +
        'and "conversations"."source_system" <> $4)',
    );
    expect(params).toEqual(['contact-1', 'whatsapp', 'row-a', 'import']);
  });

  // Null is a number no row names, matched only by another such ticket. A
  // wildcard here would let a ticket with no row absorb the person's messages
  // to every number.
  it('matches a number no row names only against tickets with no row', () => {
    const { sql, params } = statement({ channel: 'whatsapp', channelId: null });

    expect(sql).toContain(
      'and "conversations"."channel" = $2 and "conversations"."channel_id" is null ' +
        'and "conversations"."deleted_at" is null',
    );
    expect(params).toEqual(['contact-1', 'whatsapp', 'import']);
  });
});
