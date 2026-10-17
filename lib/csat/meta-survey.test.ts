import { describe, expect, it } from 'vitest';
import { metaSurveyMessage, quickReplyThanks } from './meta-survey';
import { DEFAULT_WORDING } from './wording';

/**
 * What the survey job freezes on a Meta survey's message: everything its
 * carrier needs, so `send_meta` reads the row and nothing else.
 */

const SETTINGS = { privacyUrl: 'https://shipblu.com/privacy', metaExpiresInDays: 3 };

describe('metaSurveyMessage', () => {
  it('carries Messenger’s card, and the five buttons the card falls back to', () => {
    const message = metaSurveyMessage(DEFAULT_WORDING.ar, 'ar', 'meta_template', SETTINGS);

    expect(message.text).toBe(`${DEFAULT_WORDING.ar.intro}\n${DEFAULT_WORDING.ar.question}`);
    expect(message.text).not.toContain('http');
    expect(message.meta).toEqual({
      sendKind: 'feedback_template',
      card: {
        title: DEFAULT_WORDING.ar.intro,
        subtitle: DEFAULT_WORDING.ar.subtitle,
        // Messenger's button opens the question; the rule's is a confirm.
        button: 'تقييم الخدمة',
        question: DEFAULT_WORDING.ar.question,
        placeholder: DEFAULT_WORDING.ar.commentPrompt,
        privacyUrl: SETTINGS.privacyUrl,
        expiresInDays: 3,
      },
      labels: ['سيئة جدًا', 'سيئة', 'مقبولة', 'جيدة', 'ممتازة'],
    });
  });

  it('carries only the buttons for quick replies, and needs no privacy link for them', () => {
    expect(
      metaSurveyMessage(DEFAULT_WORDING.en, 'en', 'meta_quick_reply', {
        privacyUrl: null,
        metaExpiresInDays: 3,
      }).meta,
    ).toEqual({
      sendKind: 'quick_reply_survey',
      labels: ['Very bad', 'Bad', 'Okay', 'Good', 'Great'],
    });
  });

  it('refuses to write a card Graph would refuse', () => {
    expect(() =>
      metaSurveyMessage(DEFAULT_WORDING.en, 'en', 'meta_template', {
        privacyUrl: null,
        metaExpiresInDays: 3,
      }),
    ).toThrow(/privacy/);
  });
});

describe('quickReplyThanks', () => {
  it('thanks the customer and says where anything else goes, in their language', () => {
    expect(quickReplyThanks(DEFAULT_WORDING.en, 'en')).toBe(
      `${DEFAULT_WORDING.en.thanks}\nAnything to add? Just reply here.`,
    );
    expect(quickReplyThanks(DEFAULT_WORDING.ar, 'ar')).toContain('حضرتك');
  });
});
