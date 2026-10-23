import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { withTestEnv } from '@/lib/testing/env';
import { liveConversationFilter } from './live-conversation';

/**
 * The conditions WhatsApp and the widget used to write out separately,
 * read back as SQL. No database: building a query validates the environment but
 * never opens a connection.
 */
withTestEnv();

describe('liveConversationFilter', () => {
  it('is the requester, the channel, neither deleted nor merged away, and not an import', () => {
    const { sql, params } = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(liveConversationFilter('contact-1', 'webchat'))
      .toSQL();

    expect(sql).toContain(
      'where ("conversations"."requester_contact_id" = $1 and "conversations"."channel" = $2 ' +
        'and "conversations"."deleted_at" is null and "conversations"."merged_into_id" is null ' +
        'and "conversations"."source_system" <> $3)',
    );
    expect(params).toEqual(['contact-1', 'webchat', 'import']);
  });

  // On a platform channel an external id is a public comment thread: none under
  // the CHECK, every one again if Stage 1.2 is rolled back.
  it('keeps a Meta direct message off a comment thread, and asks it of no other channel', () => {
    const statement = (channel: 'facebook' | 'instagram' | 'whatsapp') =>
      db
        .select({ id: conversations.id })
        .from(conversations)
        .where(liveConversationFilter('contact-1', channel))
        .toSQL().sql;

    for (const platform of ['facebook', 'instagram'] as const) {
      expect(statement(platform)).toContain(
        'and "conversations"."source_system" <> $3 and "conversations"."external_id" is null)',
      );
    }
    expect(statement('whatsapp')).not.toContain('external_id');
  });
});
