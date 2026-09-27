import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { withTestEnv } from '@/lib/testing/env';
import { liveConversationFilter } from './live-conversation';

/**
 * The four conditions WhatsApp and the widget used to write out separately,
 * read back as SQL. No database: building a query validates the environment but
 * never opens a connection.
 */
withTestEnv();

describe('liveConversationFilter', () => {
  it('is the requester, the channel, and neither deleted nor merged away', () => {
    const { sql, params } = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(liveConversationFilter('contact-1', 'webchat'))
      .toSQL();

    expect(sql).toContain(
      'where ("conversations"."requester_contact_id" = $1 and "conversations"."channel" = $2 ' +
        'and "conversations"."deleted_at" is null and "conversations"."merged_into_id" is null)',
    );
    expect(params).toEqual(['contact-1', 'webchat']);
  });
});
