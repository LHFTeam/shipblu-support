import { describe, expect, it } from 'vitest';
import {
  quickReplyPayload,
  quickReplySurveyRequest,
  readQuickReplyPayload,
  type RatingLabels,
} from './quick-reply-survey';

/**
 * The quick-reply survey against Meta's references (Instagram Messaging →
 * Quick Replies, and Messenger's Send Messages → Quick Replies, read
 * 2026-10-17): `message.text` with up to 13 `quick_replies` of
 * `content_type: text`, a title of at most 20 characters, and the payload
 * back on the webhook as `message.quick_reply.payload`.
 */

const SURVEY = '0b6a3f2e-9c41-4d7a-8e15-2f6c9d0a7b13';
const LABELS: RatingLabels = ['Very bad', 'Bad', 'Okay', 'Good', 'Great'];

describe('quickReplySurveyRequest', () => {
  it('puts five buttons, worst first, under the in-window body the channel already sends', () => {
    for (const platform of ['facebook', 'instagram'] as const) {
      expect(
        quickReplySurveyRequest({
          platform,
          recipientId: 'IGSID',
          surveyId: SURVEY,
          text: 'Your ticket is resolved.\nHow did we do?',
          labels: LABELS,
        }),
      ).toEqual({
        recipient: { id: 'IGSID' },
        messaging_type: 'RESPONSE',
        message: {
          text: 'Your ticket is resolved.\nHow did we do?',
          quick_replies: LABELS.map((title, index) => ({
            content_type: 'text',
            title,
            payload: `csat:${SURVEY}:${index + 1}`,
          })),
        },
      });
    }
  });

  it('cuts a title at 20 characters, counting an Arabic letter as one', () => {
    const long = 'ممتازة جدًا جدًا جدًا جدًا';
    const body = quickReplySurveyRequest({
      platform: 'instagram',
      recipientId: 'IGSID',
      surveyId: SURVEY,
      text: 'كيف كانت تجربة حضرتك مع الدعم؟',
      labels: ['سيئة جدًا', 'سيئة', 'مقبولة', 'جيدة', long],
    });
    const titles = body.message.quick_replies.map((reply) => reply.title);
    expect(titles.slice(0, 4)).toEqual(['سيئة جدًا', 'سيئة', 'مقبولة', 'جيدة']);
    expect([...titles[4]!]).toHaveLength(20);
    // Meta's payload limit is 1000; ours is a fixed 44.
    expect(body.message.quick_replies.every((reply) => reply.payload.length <= 1000)).toBe(true);
  });
});

describe('readQuickReplyPayload', () => {
  it('reads back the survey and the rating, and nothing that is not ours', () => {
    expect(readQuickReplyPayload(quickReplyPayload(SURVEY, 4))).toEqual({
      surveyId: SURVEY,
      rating: 4,
    });
    expect(readQuickReplyPayload(quickReplyPayload(SURVEY.toUpperCase(), 1))).toEqual({
      surveyId: SURVEY,
      rating: 1,
    });
    // Another flow's button, a rating off the scale, a payload with no survey.
    expect(readQuickReplyPayload('TRACK_ORDER')).toBeNull();
    expect(readQuickReplyPayload(`csat:${SURVEY}:6`)).toBeNull();
    expect(readQuickReplyPayload(`csat:${SURVEY}:0`)).toBeNull();
    expect(readQuickReplyPayload('csat:not-a-uuid:3')).toBeNull();
    expect(readQuickReplyPayload(undefined)).toBeNull();
  });
});
