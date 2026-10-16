import { describe, expect, it } from 'vitest';
import { surveyEmail } from './email';
import {
  DEFAULT_WORDING,
  EMPTY_WORDING_PAIR,
  pickWordingRule,
  ratingUrl,
  resolveWording,
  surveyText,
  wordingLength,
  wordingProblem,
  wordingProblems,
} from './wording';

/**
 * The limits are Meta's, and a wording that saves must be one that sends —
 * so the counting, the fallback and the resolution are held here, where a
 * wrong branch is a card Graph refuses or a survey in the wrong language.
 */

describe('wordingProblem', () => {
  it('holds each slot to its Meta limit, in code points', () => {
    expect(wordingProblem('intro', 'x'.repeat(65))).toBeNull();
    expect(wordingProblem('intro', 'x'.repeat(66))).toMatch(/at most 65/);
    expect(wordingProblem('subtitle', 'x'.repeat(81))).toMatch(/at most 80/);
    expect(wordingProblem('button', 'x'.repeat(21))).toMatch(/at most 20/);
    expect(wordingProblem('commentPrompt', 'x'.repeat(66))).toMatch(/at most 65/);
    expect(wordingProblem('question', 'x'.repeat(86))).toMatch(/at most 85/);
    // An emoji is two UTF-16 units and one character to Meta.
    expect(wordingLength('👍'.repeat(20))).toBe(20);
    expect(wordingProblem('button', '👍'.repeat(20))).toBeNull();
    expect(wordingProblem('thanks', 'x'.repeat(500))).toBeNull();
  });

  it('wants a question of at least five characters, and never a link', () => {
    expect(wordingProblem('question', 'Hi?')).toMatch(/at least 5/);
    expect(wordingProblem('question', '')).toBeNull();
    expect(wordingProblem('intro', 'See https://shipblu.com')).toMatch(/cannot carry a link/);
    expect(wordingProblem('intro', 'See www.shipblu.com')).toMatch(/cannot carry a link/);
    expect(wordingProblem('thanks', 'See https://shipblu.com')).toBeNull();
  });

  it('requires the question in one language and names the language of each problem', () => {
    expect(wordingProblems(EMPTY_WORDING_PAIR)).toEqual([
      'Write the question in at least one language',
    ]);
    expect(
      wordingProblems({
        ...EMPTY_WORDING_PAIR,
        questionAr: 'كيف كان الدعم؟',
        buttonEn: 'x'.repeat(21),
      }),
    ).toEqual(['Button can be at most 20 characters (English)']);
  });
});

describe('resolveWording', () => {
  it('falls back per field: own language, the other, then the built-in', () => {
    const pair = { ...EMPTY_WORDING_PAIR, questionAr: 'كيف كان الدعم؟', buttonEn: 'Rate' };
    const ar = resolveWording(pair, 'ar');
    expect(ar.question).toBe('كيف كان الدعم؟');
    expect(ar.button).toBe('Rate');
    expect(ar.thanks).toBe(DEFAULT_WORDING.ar.thanks);
    const en = resolveWording(pair, 'en');
    expect(en.question).toBe('كيف كان الدعم؟');
    expect(en.intro).toBe(DEFAULT_WORDING.en.intro);
    expect(resolveWording(null, 'en')).toEqual(DEFAULT_WORDING.en);
  });
});

describe('pickWordingRule', () => {
  const rule = (groupId: string | null, channel: string | null, isActive = true) => ({
    groupId,
    channel,
    isActive,
  });

  it('lets a channel beat a group, both beat either, and skips an inactive rule', () => {
    const rules = [rule(null, null), rule('g1', null), rule(null, 'email'), rule('g1', 'email')];
    expect(pickWordingRule(rules, { groupId: 'g1', channel: 'email' })).toBe(rules[3]);
    expect(pickWordingRule(rules, { groupId: 'g1', channel: 'webchat' })).toBe(rules[1]);
    expect(pickWordingRule(rules, { groupId: 'g2', channel: 'email' })).toBe(rules[2]);
    expect(pickWordingRule(rules, { groupId: null, channel: 'webchat' })).toBe(rules[0]);
    expect(pickWordingRule([rule(null, 'email', false)], { groupId: null, channel: 'email' })).toBe(
      null,
    );
    expect(
      pickWordingRule([rule('g1', null), rule(null, 'email')], { groupId: 'g1', channel: 'email' }),
    ).toEqual(rule(null, 'email'));
  });
});

describe('surveyEmail and surveyText', () => {
  it('carries five rating links and escapes what the admin typed', () => {
    const wording = { ...DEFAULT_WORDING.en, intro: 'Tom & Jerry <3' };
    const { text, html } = surveyEmail(wording, 'en', 'https://help.test/en/csat/tok');
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(html).toContain(`href="https://help.test/en/csat/tok?rating=${rating}"`);
      expect(text).toContain(`https://help.test/en/csat/tok?rating=${rating}`);
    }
    expect(html).toContain('Tom &amp; Jerry &lt;3');
    expect(html).not.toContain('<3');
    expect(html).toContain('dir="ltr"');
    expect(surveyEmail(DEFAULT_WORDING.ar, 'ar', 'https://help.test/ar/csat/tok').html).toContain(
      'dir="rtl"',
    );
    expect(ratingUrl('https://help.test/en/csat/preview?rule=r1', 3)).toBe(
      'https://help.test/en/csat/preview?rule=r1&rating=3',
    );
  });

  it('writes the message form as first line, question, link', () => {
    expect(surveyText({ ...DEFAULT_WORDING.en, intro: '' }, 'https://x/y')).toBe(
      'How did we do?\nhttps://x/y',
    );
  });
});
