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

import {
  automatedReplyBlocked,
  carrierFor,
  deliverAutomatedReply,
  lacksEmailRecipient,
  sendsByEmail,
} from './outbound';

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

const NOW = new Date('2026-08-19T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The guard both automated senders go through. Tested here rather than at each
 * of them because a guard that only one caller applies is not a guard, and the
 * automation engine — a cron over every live ticket — is the caller that reaches
 * the far side of every window.
 */

describe('automatedReplyBlocked', () => {
  /** A direct-message ticket on `channel`, whose customer last wrote `ago` ms back. */
  const dm = (channel: string, at: Date | null) => ({
    channel,
    externalId: null,
    lastCustomerMessageAt: at,
  });

  it('lets an automated reply through inside every window', () => {
    for (const channel of ['whatsapp', 'facebook', 'instagram']) {
      expect(automatedReplyBlocked(dm(channel, ago(2 * HOUR)), NOW)).toBeNull();
    }
  });

  it('stops a Meta reply at 24 hours, not at seven days', () => {
    // The seven days Meta allows belong to HUMAN_AGENT, and that tag may only be
    // used for a message a person wrote. So a rule's reach on these channels
    // ends where the standard window does — three days in, the send would have
    // to claim a human wrote it.
    for (const channel of ['facebook', 'instagram']) {
      expect(automatedReplyBlocked(dm(channel, ago(3 * DAY)), NOW)).toContain('HUMAN_AGENT');
      expect(automatedReplyBlocked(dm(channel, ago(8 * DAY)), NOW)).not.toBeNull();
    }
  });

  it('stops a WhatsApp reply outside its 24 hours', () => {
    expect(automatedReplyBlocked(dm('whatsapp', ago(3 * DAY)), NOW)).toContain('template');
  });

  it('never blocks a Meta comment ticket, which has no messaging window', () => {
    // A comment ticket is answered by posting to the comment edge, which
    // `send_meta` reaches before it ever consults the clock. Blocking one on the
    // customer's last message would silently stop every automated reply on a
    // public thread older than a day — replies that would have posted fine.
    for (const platform of ['facebook', 'instagram']) {
      const commentTicket = {
        channel: platform,
        externalId: `${platform}:comment:root-1`,
        lastCustomerMessageAt: ago(30 * DAY),
      };

      expect(automatedReplyBlocked(commentTicket, NOW)).toBeNull();
      // And the DM on the same channel and the same clock still is blocked, so
      // this is the external id doing the work rather than the guard going soft.
      expect(automatedReplyBlocked(dm(platform, ago(30 * DAY)), NOW)).not.toBeNull();
    }
  });

  it('stops every windowed channel when the customer has never written', () => {
    for (const channel of ['whatsapp', 'facebook', 'instagram']) {
      expect(automatedReplyBlocked(dm(channel, null), NOW)).not.toBeNull();
    }
  });

  it('measures against the real clock by default', () => {
    /*
      The regression that made every guard here unreachable. The out-of-hours
      sender used to pass the inbound message's own `sentAt` as `now` — and
      ingest writes that same instant to `lastCustomerMessageAt`, so the window
      was measured against itself and reported open for a message of any age.
      A default of `new Date()` is what makes a replayed backlog refuse.
    */
    const longAgo = new Date('2020-01-01T00:00:00Z');

    expect(automatedReplyBlocked(dm('whatsapp', longAgo))).not.toBeNull();
    expect(automatedReplyBlocked(dm('facebook', longAgo))).not.toBeNull();
    // The shape of the bug, spelled out: pass that instant as the clock and
    // everything opens again.
    expect(automatedReplyBlocked(dm('facebook', longAgo), longAgo)).toBeNull();
  });

  it('leaves the channels that have no window alone', () => {
    // Email, the portal and web chat can be written to whenever — an old ticket
    // is not a closed door there, and blocking one would silence the
    // acknowledgement on the channel it matters most on.
    for (const channel of ['email', 'portal', 'webchat']) {
      expect(automatedReplyBlocked(dm(channel, ago(30 * DAY)), NOW)).toBeNull();
      expect(automatedReplyBlocked(dm(channel, null), NOW)).toBeNull();
    }
  });
});

describe('carrierFor', () => {
  it('sends a Meta ticket to send_meta rather than to email', () => {
    // The mapping `send_csat` used to keep its own broken copy of: a survey on a
    // Facebook ticket queued as an email to a contact with no address.
    expect(carrierFor('facebook')).toBe('send_meta');
    expect(carrierFor('instagram')).toBe('send_meta');
    expect(carrierFor('whatsapp')).toBe('send_whatsapp');
    expect(carrierFor('email')).toBe('send_email');
    expect(carrierFor('portal')).toBe('send_email');
  });
});

describe('sendsByEmail', () => {
  it('writes a portal message as an email, as it writes an email one', () => {
    // The check an agent's reply and the CSAT survey each made as
    // `channel === 'email'`, which stored a portal message with no HTML part
    // and no recipient although `send_email` is what carries it.
    expect(sendsByEmail('email')).toBe(true);
    expect(sendsByEmail('portal')).toBe(true);
  });

  it('writes nothing as an email for a channel another carrier takes, or none does', () => {
    for (const channel of ['whatsapp', 'facebook', 'instagram', 'webchat']) {
      expect(sendsByEmail(channel)).toBe(false);
    }
  });

  // `carrierFor` sends anything it does not recognise to `send_email`, so these
  // two are pinned rather than left to whatever that fallback happens to say.
  it('writes an api message as an email, and nothing on the read-only bot channel', () => {
    expect(sendsByEmail('api')).toBe(true);
    expect(sendsByEmail('whatsapp_bot')).toBe(false);
  });
});

describe('lacksEmailRecipient', () => {
  it('stops an automated message to a portal contact with no address', () => {
    // The out-of-hours acknowledgement asked `channel === 'email'` here, so this
    // ticket passed, was queued to `send_email`, and failed on every retry.
    expect(lacksEmailRecipient('portal', null)).toBe(true);
    expect(lacksEmailRecipient('email', null)).toBe(true);
  });

  it('lets through a ticket with an address, or one no email carries', () => {
    expect(lacksEmailRecipient('portal', 'customer@example.com')).toBe(false);
    expect(lacksEmailRecipient('whatsapp', null)).toBe(false);
    expect(lacksEmailRecipient('webchat', null)).toBe(false);
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
