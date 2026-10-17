import { describe, expect, it } from 'vitest';
import {
  feedbackQuestionId,
  feedbackTemplateRequest,
  surveyIdFromQuestionId,
  type FeedbackCard,
} from './feedback-template';

/**
 * The card's request against Meta's reference (Messenger Platform → Send
 * Messages → Templates → Customer Feedback Template, read 2026-10-17). Graph
 * answers a wrong shape with `(#100)` and nothing else, so this is the only
 * place the shape is checked before production sends it.
 */

const SURVEY = '0b6a3f2e-9c41-4d7a-8e15-2f6c9d0a7b13';

const CARD: FeedbackCard = {
  title: 'Your ticket is resolved.',
  subtitle: 'It takes ten seconds to tell us how it went.',
  button: 'Send',
  question: 'How did we do?',
  placeholder: 'Anything you would like to add? (optional)',
  privacyUrl: 'https://shipblu.com/privacy',
  expiresInDays: 3,
};

describe('feedbackTemplateRequest', () => {
  it('builds the reference example’s shape, with our words and a question id Meta accepts', () => {
    const body = feedbackTemplateRequest({
      recipientId: 'PSID',
      surveyId: SURVEY,
      card: CARD,
      tag: 'RESPONSE',
    });

    expect(body).toEqual({
      recipient: { id: 'PSID' },
      messaging_type: 'RESPONSE',
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'customer_feedback',
            title: CARD.title,
            subtitle: CARD.subtitle,
            button_title: CARD.button,
            feedback_screens: [
              {
                questions: [
                  {
                    id: 'csat_0b6a3f2e9c414d7a8e152f6c9d0a7b13',
                    type: 'csat',
                    title: CARD.question,
                    score_label: 'neg_pos',
                    score_option: 'five_stars',
                    follow_up: { type: 'free_form', placeholder: CARD.placeholder },
                  },
                ],
              },
            ],
            business_privacy: { url: CARD.privacyUrl },
            expires_in_days: 3,
          },
        },
      },
    });
    // "Alphanumeric … can contain any number of underscores": a hyphen is
    // refused, and the id is at most 80 characters.
    const id = body.message.attachment.payload.feedback_screens[0]!.questions[0]!.id;
    expect(id).toMatch(/^[A-Za-z0-9_]{1,80}$/);
    // One screen with one question is all the reference allows.
    expect(body.message.attachment.payload.feedback_screens).toHaveLength(1);
  });

  it('sends with the CUSTOMER_FEEDBACK tag past the 24 hours, and never HUMAN_AGENT', () => {
    const body = feedbackTemplateRequest({
      recipientId: 'PSID',
      surveyId: SURVEY,
      card: CARD,
      tag: 'CUSTOMER_FEEDBACK',
    });
    expect(body.messaging_type).toBe('MESSAGE_TAG');
    expect(body.tag).toBe('CUSTOMER_FEEDBACK');

    const inside = feedbackTemplateRequest({
      recipientId: 'PSID',
      surveyId: SURVEY,
      card: CARD,
      tag: 'RESPONSE',
    });
    expect(inside).not.toHaveProperty('tag');
  });

  it('holds the expiry to the 1–7 days Meta takes', () => {
    const expiry = (expiresInDays: number) =>
      feedbackTemplateRequest({
        recipientId: 'PSID',
        surveyId: SURVEY,
        card: { ...CARD, expiresInDays },
        tag: 'RESPONSE',
      }).message.attachment.payload.expires_in_days;
    expect(expiry(0)).toBe(1);
    expect(expiry(9)).toBe(7);
    expect(expiry(7)).toBe(7);
  });
});

describe('the question id', () => {
  it('names the survey it was built from, and nothing else', () => {
    expect(surveyIdFromQuestionId(feedbackQuestionId(SURVEY))).toBe(SURVEY);
    expect(surveyIdFromQuestionId(feedbackQuestionId(SURVEY.toUpperCase()))).toBe(SURVEY);
    // Somebody else's question, or a shape that is not ours, is not an answer.
    expect(surveyIdFromQuestionId('hauydmns8')).toBeNull();
    expect(surveyIdFromQuestionId('csat_0b6a3f2e')).toBeNull();
    expect(surveyIdFromQuestionId(`csat_${SURVEY}`)).toBeNull();
    expect(surveyIdFromQuestionId(42)).toBeNull();
  });
});
