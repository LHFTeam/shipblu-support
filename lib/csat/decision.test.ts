import { describe, expect, it } from 'vitest';
import { channelSurveyed, channelSwitch, decideSurvey, type DecisionInput } from './decision';
import { UNSET_CSAT_SETTINGS, type CsatSettings } from './settings';

/**
 * The order the reasons are reported in, and the delivery each channel gets.
 * The job writes whatever this answers, so a wrong branch here is a customer
 * surveyed in public or an admin reading the wrong reason on every ticket.
 */

const ON: CsatSettings = {
  ...UNSET_CSAT_SETTINGS,
  enabled: true,
  channels: { email: true, webchat: true, facebook: true, instagram: true, api: true },
};

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    channel: 'email',
    statusCategory: 'resolved',
    deletedAt: null,
    isSpam: false,
    mergedIntoId: null,
    hasCustomerMessage: true,
    suppressed: false,
    trigger: 'agent',
    contactEmail: 'amira@example.test',
    commentThread: false,
    metaWindowOpen: true,
    readOnly: false,
    byEmail: true,
    ...overrides,
  };
}

describe('decideSurvey', () => {
  it('writes nothing for a ticket that is gone', () => {
    expect(decideSurvey(input({ deletedAt: new Date() }), ON)).toEqual({ kind: 'drop' });
    expect(decideSurvey(input({ isSpam: true }), ON)).toEqual({ kind: 'drop' });
    expect(decideSurvey(input({ mergedIntoId: 'other' }), ON)).toEqual({ kind: 'drop' });
    // Gone beats switched off: there is no ticket to write the reason on.
    expect(decideSurvey(input({ isSpam: true }), UNSET_CSAT_SETTINGS)).toEqual({ kind: 'drop' });
  });

  it('says "switched off" before anything else, and "channel off" next', () => {
    expect(decideSurvey(input({ statusCategory: 'open' }), UNSET_CSAT_SETTINGS)).toEqual({
      kind: 'skip',
      reason: 'csat_off',
    });
    expect(
      decideSurvey(input({ channel: 'webchat', byEmail: false }), {
        ...ON,
        channels: { ...ON.channels, webchat: false },
      }),
    ).toEqual({ kind: 'skip', reason: 'channel_off' });
  });

  it('names a channel nobody writes to before any switch, and one with no switch after it', () => {
    // The bot's conversations are another service's whatever the switch says.
    expect(
      decideSurvey(
        input({ channel: 'whatsapp_bot', byEmail: false, readOnly: true }),
        UNSET_CSAT_SETTINGS,
      ),
    ).toEqual({ kind: 'skip', reason: 'read_only_channel' });
    // WhatsApp has no switch to be off: "off for this channel" would send an
    // admin looking for a toggle that does not exist.
    expect(decideSurvey(input({ channel: 'whatsapp', byEmail: false }), ON)).toEqual({
      kind: 'skip',
      reason: 'channel_unsupported',
    });
  });

  it('reports the reasons in the order a person would want them', () => {
    expect(decideSurvey(input({ statusCategory: 'open', hasCustomerMessage: false }), ON)).toEqual({
      kind: 'skip',
      reason: 'reopened',
    });
    expect(decideSurvey(input({ hasCustomerMessage: false, suppressed: true }), ON)).toEqual({
      kind: 'skip',
      reason: 'no_customer_message',
    });
    expect(decideSurvey(input({ suppressed: true, contactEmail: null }), ON)).toEqual({
      kind: 'skip',
      reason: 'agent_suppressed',
    });
  });

  it('surveys a closed ticket as a resolved one', () => {
    expect(decideSurvey(input({ statusCategory: 'closed' }), ON)).toEqual({
      kind: 'send',
      delivery: 'email_link',
    });
  });

  it('leaves a rule-resolved ticket alone only when the admin said so', () => {
    expect(decideSurvey(input({ trigger: 'rule' }), ON).kind).toBe('send');
    expect(decideSurvey(input({ trigger: 'rule' }), { ...ON, surveyRuleResolved: false })).toEqual({
      kind: 'skip',
      reason: 'rule_resolved',
    });
    // The switch is about rules; an agent's resolve is unaffected by it.
    expect(decideSurvey(input(), { ...ON, surveyRuleResolved: false }).kind).toBe('send');
  });

  it('writes an email where the carrier is email, and skips when there is nowhere to send it', () => {
    expect(decideSurvey(input({ channel: 'portal' }), ON)).toEqual({
      kind: 'send',
      delivery: 'email_link',
    });
    expect(decideSurvey(input({ channel: 'api', contactEmail: null }), ON)).toEqual({
      kind: 'skip',
      reason: 'no_address',
    });
  });

  it('sends a message on web chat, and on Meta only inside the window', () => {
    expect(decideSurvey(input({ channel: 'webchat', byEmail: false }), ON)).toEqual({
      kind: 'send',
      delivery: 'text_link',
    });
    expect(decideSurvey(input({ channel: 'facebook', byEmail: false }), ON)).toEqual({
      kind: 'send',
      delivery: 'text_link',
    });
    expect(
      decideSurvey(input({ channel: 'instagram', byEmail: false, metaWindowOpen: false }), ON),
    ).toEqual({ kind: 'skip', reason: 'window_closed' });
  });

  it('never surveys a public comment thread, whatever the window says', () => {
    // `automatedReplyBlocked` lets a comment ticket through because it has no
    // window — which is exactly why the survey, link and all, would be posted
    // on the comment for anybody reading the post to answer.
    expect(
      decideSurvey(
        input({ channel: 'facebook', byEmail: false, commentThread: true, metaWindowOpen: true }),
        ON,
      ),
    ).toEqual({ kind: 'skip', reason: 'comment_thread' });
    // And a comment thread is not an email ticket, so the email branch never
    // reaches it; a comment ticket on email does not exist.
    expect(decideSurvey(input({ commentThread: true }), ON).kind).toBe('send');
  });
});

describe('channelSurveyed', () => {
  it('puts portal on the email switch and gives WhatsApp none', () => {
    const only = (channel: keyof CsatSettings['channels']) => ({
      ...ON,
      channels: {
        email: false,
        webchat: false,
        facebook: false,
        instagram: false,
        api: false,
        [channel]: true,
      },
    });
    expect(channelSurveyed(only('email'), 'portal')).toBe(true);
    expect(channelSurveyed(only('webchat'), 'portal')).toBe(false);
    expect(channelSurveyed(ON, 'whatsapp')).toBe(false);
    expect(channelSurveyed(ON, 'whatsapp_bot')).toBe(false);
    expect(channelSwitch('portal')).toBe('email');
    expect(channelSwitch('whatsapp')).toBeNull();
  });
});
