import { describe, expect, it } from 'vitest';
import { describeWindow, messagingTag, metaWindowState } from './window';

const NOW = new Date('2026-08-19T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('metaWindowState', () => {
  it('is open inside 24 hours', () => {
    const state = metaWindowState(ago(2 * HOUR), NOW);
    expect(state).toMatchObject({ isOpen: true, needsHumanAgentTag: false, reason: 'open' });
    expect(messagingTag(state, 'human')).toBe('RESPONSE');
  });

  it('needs the human agent tag between 24 hours and 7 days', () => {
    // The window a support team actually lives in: a customer who wrote
    // yesterday still deserves an answer, and HUMAN_AGENT is how Meta allows it.
    const state = metaWindowState(ago(3 * DAY), NOW);
    expect(state).toMatchObject({
      isOpen: false,
      needsHumanAgentTag: true,
      isClosed: false,
      reason: 'human_agent_only',
    });
    expect(messagingTag(state, 'human')).toBe('HUMAN_AGENT');
  });

  it('is closed after 7 days, with no template escape', () => {
    // Unlike WhatsApp there is no paid template to reopen with, so this really
    // is the end until the customer writes again.
    const state = metaWindowState(ago(8 * DAY), NOW);
    expect(state).toMatchObject({ isClosed: true, reason: 'expired' });
    expect(messagingTag(state, 'human')).toBeNull();
  });

  it('treats the boundaries as the moment they expire', () => {
    expect(metaWindowState(ago(24 * HOUR), NOW).reason).toBe('human_agent_only');
    expect(metaWindowState(ago(24 * HOUR - 1), NOW).reason).toBe('open');
    expect(metaWindowState(ago(7 * DAY), NOW).reason).toBe('expired');
    expect(metaWindowState(ago(7 * DAY - 1), NOW).reason).toBe('human_agent_only');
  });

  it('is closed when the customer has never written', () => {
    const state = metaWindowState(null, NOW);
    expect(state).toMatchObject({ isClosed: true, reason: 'never_opened' });
    expect(messagingTag(state, 'human')).toBeNull();
  });

  it('describes each state in the agent’s terms', () => {
    expect(describeWindow(metaWindowState(ago(HOUR), NOW))).toContain('reply freely');
    expect(describeWindow(metaWindowState(ago(2 * DAY), NOW))).toContain('human agent');
    expect(describeWindow(metaWindowState(ago(9 * DAY), NOW))).toContain('7-day window has closed');
    expect(describeWindow(metaWindowState(null, NOW))).toContain('No customer message');
  });

  it('counts down in days once past the first', () => {
    // Two days in, five of the seven remain.
    expect(describeWindow(metaWindowState(ago(2 * DAY), NOW))).toContain('5d');
  });
});

describe('messagingTag and who wrote the message', () => {
  it('refuses HUMAN_AGENT for an automated message outside the 24-hour window', () => {
    // The whole point of the tag: it says a person is answering. A rule firing
    // three days after the customer wrote is not a person, and Meta's Human
    // Agent feature reference is explicit that the tag is for a human agent
    // responding — using it otherwise risks messaging restrictions on the app.
    const state = metaWindowState(ago(3 * DAY), NOW);

    expect(messagingTag(state, 'human')).toBe('HUMAN_AGENT');
    expect(messagingTag(state, 'automated')).toBeNull();
  });

  it('still lets an automated message send inside the window', () => {
    // Nothing about the standard window is a claim about who wrote the reply,
    // so an out-of-hours acknowledgement minutes after the customer's message
    // goes out exactly as before.
    expect(messagingTag(metaWindowState(ago(2 * HOUR), NOW), 'automated')).toBe('RESPONSE');
  });

  it('answers null for both authors once the seven days are gone', () => {
    const state = metaWindowState(ago(8 * DAY), NOW);
    expect(messagingTag(state, 'human')).toBeNull();
    expect(messagingTag(state, 'automated')).toBeNull();
  });
});
