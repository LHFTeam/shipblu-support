import { describe, expect, it } from 'vitest';
import { channelSurveyed, decideSurvey, type DecisionInput } from './decision';
import { UNSET_CSAT_SETTINGS, type CsatSettings } from './settings';

/**
 * The order the reasons are reported in, and the delivery each channel gets.
 * The job writes whatever this answers, so a wrong branch here is a customer
 * surveyed twice or an admin reading the wrong reason on every ticket.
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
    hasCustomerWords: true,
    suppressed: false,
    trigger: 'agent',
    recentlySurveyed: false,
    contactEmail: 'amira@example.test',
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
    ).toEqual({
      kind: 'skip',
      reason: 'channel_off',
    });
  });

  it('reports the reasons in the order a person would want them', () => {
    expect(decideSurvey(input({ statusCategory: 'open', readOnly: true }), ON)).toEqual({
      kind: 'skip',
      reason: 'reopened',
    });
    expect(decideSurvey(input({ hasCustomerWords: false, suppressed: true }), ON)).toEqual({
      kind: 'skip',
      reason: 'no_customer_message',
    });
    expect(decideSurvey(input({ suppressed: true, recentlySurveyed: true }), ON)).toEqual({
      kind: 'skip',
      reason: 'agent_suppressed',
    });
    expect(decideSurvey(input({ recentlySurveyed: true }), ON)).toEqual({
      kind: 'skip',
      reason: 'recently_surveyed',
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

  it('never surveys a channel the team does not write to', () => {
    expect(decideSurvey(input({ channel: 'whatsapp', byEmail: false }), ON)).toEqual({
      kind: 'skip',
      reason: 'channel_off',
    });
    expect(
      decideSurvey(input({ channel: 'whatsapp_bot', byEmail: false, readOnly: true }), ON),
    ).toEqual({ kind: 'skip', reason: 'channel_off' });
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
  });
});
