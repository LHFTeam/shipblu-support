import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  insert: vi.fn(),
  insertValues: vi.fn(),
  update: vi.fn(),
  updateSet: vi.fn(),
  updateWhere: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    insert: mocks.insert,
    update: mocks.update,
  },
}));

vi.mock('@/lib/queue', () => ({ enqueue: mocks.enqueue }));

import { deliverAutomatedReply } from './outbound';

describe('deliverAutomatedReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.insertValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'message-1' }]),
    });
    mocks.insert.mockReturnValue({ values: mocks.insertValues });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.updateSet.mockReturnValue({ where: mocks.updateWhere });
    mocks.update.mockReturnValue({ set: mocks.updateSet });
  });

  it('leaves the ticket awaiting an agent', async () => {
    await deliverAutomatedReply({
      conversationId: 'conversation-1',
      channel: 'webchat',
      requesterEmail: null,
      bodyText: 'We received your message.',
      bodyHtml: null,
      actorLabel: 'automation:acknowledge',
      eventType: 'auto_replied',
    });

    expect(mocks.updateSet).toHaveBeenCalledOnce();
    expect(mocks.updateSet.mock.calls[0]![0]).not.toHaveProperty('lastAgentMessageAt');
    expect(mocks.updateSet.mock.calls[0]![0]).toHaveProperty('lastMessageAt', expect.any(Date));
  });

  // The rule engine's only signal that the acknowledgement already went out.
  // Written here rather than by each sender so the out-of-hours reply and the
  // automation's canned reply cannot disagree about what an auto-reply is.
  it('stamps the auto-reply without overwriting an earlier one', async () => {
    await deliverAutomatedReply({
      conversationId: 'conversation-1',
      channel: 'webchat',
      requesterEmail: null,
      bodyText: 'We received your message.',
      bodyHtml: null,
      actorLabel: 'automation:acknowledge',
      eventType: 'auto_replied',
    });

    const written = mocks.updateSet.mock.calls[0]![0] as Record<string, unknown>;
    const stamp = written.firstAutoRepliedAt as { queryChunks?: unknown[] } | undefined;

    // A coalesce, not a Date: a second acknowledgement on the same ticket must
    // leave the first one's timestamp alone, or a rule keyed off it fires again.
    expect(stamp).toBeDefined();
    expect(stamp).not.toBeInstanceOf(Date);
    expect(sqlShape(stamp!.queryChunks!)).toBe('coalesce( first_auto_replied_at ,  ? )');
  });
});

/**
 * The chunks a Drizzle `sql` fragment is built from, as readable text.
 *
 * Serialising them wholesale does not work — a column chunk holds its table,
 * which holds its columns — so this takes the literal text of each string chunk
 * and the name of each column, and reduces everything else to a placeholder.
 */
function sqlShape(chunks: unknown[]): string {
  return chunks
    .map((chunk) => {
      const node = chunk as { value?: unknown; name?: unknown };
      if (Array.isArray(node.value)) return node.value.join('');
      if (typeof node.name === 'string') return node.name;
      return '?';
    })
    .join(' ');
}
