import { describe, expect, it } from 'vitest';
import type { SessionAgent } from '@/lib/auth/session';
import {
  answeredFromConsole,
  canSeeChannel,
  commentChannelOf,
  consoleReplyNotice,
  consoleReplyReason,
  CONVERSATION_CHANNELS,
  drawsMediaInline,
  FILTERABLE_CHANNELS,
  hasWrittenSubject,
  hiddenChannels,
  isCommentChannel,
  isCommentTicket,
  isMetaChannel,
  isReadOnlyChannel,
  isRestrictedChannel,
  metaPlatformOf,
  readOnlyChannels,
  readOnlyReason,
  restrictedChannels,
} from './channel-policy';

function agent(role: SessionAgent['role'], permissions: Record<string, boolean> = {}) {
  return { role, permissions } as SessionAgent;
}

it('lists every database channel, including ones only shown through all', () => {
  expect(CONVERSATION_CHANNELS).toEqual([
    'email',
    'whatsapp',
    'webchat',
    'facebook',
    'facebook_comment',
    'instagram',
    'instagram_comment',
    'portal',
    'api',
    'whatsapp_bot',
  ]);
});

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

describe('channels not answered from the console', () => {
  it('covers WhatsApp and no channel the team replies on', () => {
    expect(consoleReplyReason('whatsapp')).toMatch(/whatsapp/i);
    for (const channel of ['email', 'webchat', 'facebook', 'instagram', 'portal', 'api']) {
      expect(consoleReplyReason(channel)).toBeNull();
    }
  });

  it('is separate from read-only, so WhatsApp stays in the queue and the figures', () => {
    // Folding WhatsApp into read-only would drop it from the inbox, the SLA
    // sweep and the reports; only the composer's customer-facing half goes.
    expect(isReadOnlyChannel('whatsapp')).toBe(false);
    expect(readOnlyChannels()).not.toContain('whatsapp');
  });

  it('answers from the console exactly where neither rule refuses', () => {
    // The one predicate the page, the suggestion route and the window badges
    // ask; it must agree with both refusals for every channel there is.
    for (const channel of CONVERSATION_CHANNELS) {
      expect(answeredFromConsole(channel)).toBe(
        !readOnlyReason(channel) && !consoleReplyReason(channel),
      );
    }
    expect(answeredFromConsole('email')).toBe(true);
    expect(answeredFromConsole('whatsapp')).toBe(false);
    expect(answeredFromConsole('whatsapp_bot')).toBe(false);
  });

  it('gives the notice and the refusal for the same channels', () => {
    for (const channel of CONVERSATION_CHANNELS) {
      expect(consoleReplyNotice(channel) === null).toBe(consoleReplyReason(channel) === null);
    }
    // Not a prototype key read off the table as if it were a channel.
    expect(consoleReplyReason('toString')).toBeNull();
  });

  it('says what the agent can still do, since a stale reply box is refused with it', () => {
    expect(consoleReplyReason('whatsapp')).toMatch(/private notes/);
  });
});

describe('restricted channels are opt-in, separately from permission', () => {
  it('lists the channel whoever is asking', () => {
    // The distinction that matters: `hiddenChannels` answers "may this person
    // see it", `restrictedChannels` answers "is it part of all channels". An
    // admin may see the bot channel and still should not have it in their
    // working queue.
    expect(restrictedChannels()).toEqual(['whatsapp_bot']);
    expect(hiddenChannels(agent('admin'))).toEqual([]);
  });

  it('is not narrowed by holding the permission', () => {
    const trusted = agent('supervisor', { 'ticket.view.bot': true });
    expect(hiddenChannels(trusted)).toEqual([]);
    expect(restrictedChannels()).toEqual(['whatsapp_bot']);
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

it('keeps a subject on the card only on the channels where somebody wrote one', () => {
  // Over every channel, so a new one is answered here rather than defaulting.
  expect(CONVERSATION_CHANNELS.filter(hasWrittenSubject)).toEqual(['email', 'portal']);
});

it('draws files inline only on a chat, so email and anything added later stay attachments', () => {
  expect(CONVERSATION_CHANNELS.filter(drawsMediaInline)).toEqual([
    'whatsapp',
    'webchat',
    'facebook',
    'facebook_comment',
    'instagram',
    'instagram_comment',
    'whatsapp_bot',
  ]);
});

describe('the Meta channels', () => {
  // Over every channel, so a new one is placed here rather than defaulting.
  it('are the two platforms and their comments', () => {
    expect(CONVERSATION_CHANNELS.filter(isMetaChannel)).toEqual([
      'facebook',
      'facebook_comment',
      'instagram',
      'instagram_comment',
    ]);
    expect(CONVERSATION_CHANNELS.filter(isCommentChannel)).toEqual([
      'facebook_comment',
      'instagram_comment',
    ]);
  });

  it('ride their platform', () => {
    expect(metaPlatformOf('facebook')).toBe('facebook');
    expect(metaPlatformOf('facebook_comment')).toBe('facebook');
    expect(metaPlatformOf('instagram')).toBe('instagram');
    expect(metaPlatformOf('instagram_comment')).toBe('instagram');
  });

  it('file each platform’s comments on a comment channel of its own', () => {
    expect(commentChannelOf('facebook')).toBe('facebook_comment');
    expect(commentChannelOf('instagram')).toBe('instagram_comment');
    for (const platform of ['facebook', 'instagram'] as const) {
      expect(metaPlatformOf(commentChannelOf(platform))).toBe(platform);
    }
  });

  // One test for every reader, so the composer and the guards cannot disagree
  // about a ticket the way two spellings of the external-id test once could.
  it('tell a comment ticket by its channel, or by its external id until 1.2 moves it', () => {
    expect(isCommentTicket('facebook_comment', null)).toBe(true);
    expect(isCommentTicket('instagram_comment', 'instagram:comment:17890')).toBe(true);
    expect(isCommentTicket('facebook', 'facebook:comment:1_2')).toBe(true);
    expect(isCommentTicket('instagram', 'instagram:comment:17890')).toBe(true);
    // A direct message carries no external id.
    expect(isCommentTicket('facebook', null)).toBe(false);
    // The prefix is anchored: ':comment:' elsewhere in an id is not a comment.
    expect(isCommentTicket('whatsapp', 'whatsapp:comment:1')).toBe(false);
    expect(isCommentTicket('email', 'x-facebook:comment:1')).toBe(false);
  });

  // Offered with the ingest that writes them (Stage 1.2), so the views are
  // never a queue of tickets nothing could file there.
  it('are offered as filters, beside their platforms', () => {
    expect(FILTERABLE_CHANNELS.filter(isMetaChannel)).toEqual([
      'facebook',
      'facebook_comment',
      'instagram',
      'instagram_comment',
    ]);
  });

  it('are not prototype keys or near misses', () => {
    expect(isMetaChannel('toString')).toBe(false);
    expect(isMetaChannel('facebook_comments')).toBe(false);
    expect(isCommentChannel('facebook')).toBe(false);
  });
});
