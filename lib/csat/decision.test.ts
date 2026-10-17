import { describe, expect, it } from 'vitest';
import {
  cardRefusalStands,
  channelSurveyed,
  channelSwitch,
  decideSurvey,
  surveyAvailability,
  type DecisionInput,
} from './decision';
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
  privacyUrl: 'https://shipblu.com/privacy',
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
    resolvedByRule: false,
    lacksRecipient: false,
    commentThread: false,
    metaWindowOpen: true,
    feedbackWindowOpen: true,
    cardRefused: false,
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
    expect(decideSurvey(input({ suppressed: true, lacksRecipient: true }), ON)).toEqual({
      kind: 'skip',
      reason: 'agent_suppressed',
    });
  });

  it('surveys a closed ticket as a resolved one, except a chat nobody can open again', () => {
    expect(decideSurvey(input({ statusCategory: 'closed' }), ON)).toEqual({
      kind: 'send',
      delivery: 'email_link',
    });
    const closedChat = input({ channel: 'webchat', byEmail: false, statusCategory: 'closed' });
    expect(decideSurvey(closedChat, ON)).toEqual({ kind: 'skip', reason: 'chat_closed' });
    // A delivery reason, so the ticket's own reasons come first: an agent who
    // asked that it not be surveyed is the answer, and the report counts it.
    expect(decideSurvey({ ...closedChat, suppressed: true }, ON)).toEqual({
      kind: 'skip',
      reason: 'agent_suppressed',
    });
    expect(decideSurvey({ ...closedChat, hasCustomerMessage: false }, ON)).toEqual({
      kind: 'skip',
      reason: 'no_customer_message',
    });
  });

  it('leaves a rule-resolved ticket alone only when the admin said so', () => {
    expect(decideSurvey(input({ resolvedByRule: true }), ON).kind).toBe('send');
    expect(
      decideSurvey(input({ resolvedByRule: true }), { ...ON, surveyRuleResolved: false }),
    ).toEqual({ kind: 'skip', reason: 'rule_resolved' });
    // The switch is about rules; an agent's resolve is unaffected by it.
    expect(
      decideSurvey(input({ resolvedByRule: false }), { ...ON, surveyRuleResolved: false }).kind,
    ).toBe('send');
  });

  it('writes an email where the carrier is email, and skips when there is nowhere to send it', () => {
    expect(decideSurvey(input({ channel: 'portal' }), ON)).toEqual({
      kind: 'send',
      delivery: 'email_link',
    });
    expect(decideSurvey(input({ channel: 'api', lacksRecipient: true }), ON)).toEqual({
      kind: 'skip',
      reason: 'no_address',
    });
  });

  it('sends a card on web chat', () => {
    expect(decideSurvey(input({ channel: 'webchat', byEmail: false }), ON)).toEqual({
      kind: 'send',
      delivery: 'widget_card',
    });
  });

  it("sends Messenger's card for the seven days its tag allows, and buttons without a privacy link", () => {
    const facebook = (overrides: Partial<DecisionInput> = {}) =>
      input({ channel: 'facebook', byEmail: false, ...overrides });

    expect(decideSurvey(facebook(), ON)).toEqual({ kind: 'send', delivery: 'meta_template' });
    // Past the 24 hours, inside the seven days: the card's own tag carries it.
    expect(decideSurvey(facebook({ metaWindowOpen: false }), ON)).toEqual({
      kind: 'send',
      delivery: 'meta_template',
    });
    expect(
      decideSurvey(facebook({ metaWindowOpen: false, feedbackWindowOpen: false }), ON),
    ).toEqual({ kind: 'skip', reason: 'window_closed' });

    // Graph refuses the card without the link, so none is written: inside the
    // 24 hours the survey goes as rating buttons, which need no link; past
    // them the missing link is the reason, because with one the card would
    // have gone; and past the seven days, the window is.
    const noLink = { ...ON, privacyUrl: null };
    expect(decideSurvey(facebook(), noLink)).toEqual({
      kind: 'send',
      delivery: 'meta_quick_reply',
    });
    expect(decideSurvey(facebook({ metaWindowOpen: false }), noLink)).toEqual({
      kind: 'skip',
      reason: 'no_privacy_url',
    });
    expect(
      decideSurvey(facebook({ metaWindowOpen: false, feedbackWindowOpen: false }), noLink),
    ).toEqual({ kind: 'skip', reason: 'window_closed' });
  });

  it('tries a card Messenger last refused only where the buttons can follow it', () => {
    const facebook = (overrides: Partial<DecisionInput> = {}) =>
      input({ channel: 'facebook', byEmail: false, cardRefused: true, ...overrides });

    // Inside the 24 hours: the card still goes, falls back to buttons if it is
    // refused again, and clears the refusal if it is not.
    expect(decideSurvey(facebook(), ON)).toEqual({ kind: 'send', delivery: 'meta_template' });
    // Past them nothing would carry it, so nothing is written to fail.
    expect(decideSurvey(facebook({ metaWindowOpen: false }), ON)).toEqual({
      kind: 'skip',
      reason: 'card_refused',
    });
    // A missing link says more than a refusal, and a closed window more than either.
    expect(decideSurvey(facebook({ metaWindowOpen: false }), { ...ON, privacyUrl: null })).toEqual({
      kind: 'skip',
      reason: 'no_privacy_url',
    });
    expect(
      decideSurvey(facebook({ metaWindowOpen: false, feedbackWindowOpen: false }), ON),
    ).toEqual({ kind: 'skip', reason: 'window_closed' });
    // Instagram has no card to have been refused.
    expect(
      decideSurvey(input({ channel: 'instagram', byEmail: false, cardRefused: true }), ON),
    ).toEqual({ kind: 'send', delivery: 'meta_quick_reply' });
  });

  it('lets a refusal stand for a day, so a survey past the 24 hours tries the card again', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const refusal = (hoursAgo: number) => ({
      text: '(#100) Unsupported post request.',
      at: new Date(now.getTime() - hoursAgo * 3_600_000),
    });
    expect(cardRefusalStands(null, now)).toBe(false);
    expect(cardRefusalStands(refusal(1), now)).toBe(true);
    expect(cardRefusalStands(refusal(23.9), now)).toBe(true);
    // With a Meta delay of a day or more no card is ever sent inside the 24
    // hours to clear it; lapsing is what keeps Facebook from going quiet for good.
    expect(cardRefusalStands(refusal(24), now)).toBe(false);
  });

  it('sends quick replies on Instagram only inside the 24 hours, whatever the card could do', () => {
    const instagram = (overrides: Partial<DecisionInput> = {}) =>
      input({ channel: 'instagram', byEmail: false, ...overrides });

    expect(decideSurvey(instagram(), ON)).toEqual({ kind: 'send', delivery: 'meta_quick_reply' });
    // Instagram has no card, so the card's seven days are no reason to send.
    expect(
      decideSurvey(instagram({ metaWindowOpen: false, feedbackWindowOpen: true }), ON),
    ).toEqual({ kind: 'skip', reason: 'window_closed' });
    // Nor does it need the privacy link the card does.
    expect(decideSurvey(instagram(), { ...ON, privacyUrl: null })).toEqual({
      kind: 'send',
      delivery: 'meta_quick_reply',
    });
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

describe('surveyAvailability', () => {
  it('says "off" only for a switch somebody turned off, never for settings it could not read', () => {
    expect(surveyAvailability(ON, 'email')).toBe('on');
    expect(surveyAvailability({ ...ON, enabled: false }, 'email')).toBe('off');
    expect(
      surveyAvailability({ ...ON, channels: { ...ON.channels, webchat: false } }, 'webchat'),
    ).toBe('channel_off');
    // A failed read: the sidebar must not tell the agent surveys are off.
    expect(surveyAvailability(null, 'email')).toBe('unknown');
    // A channel with no switch is the same answer whatever the settings say,
    // read or not.
    expect(surveyAvailability(null, 'whatsapp')).toBe('unsupported');
    expect(surveyAvailability(ON, 'whatsapp')).toBe('unsupported');
  });
});
