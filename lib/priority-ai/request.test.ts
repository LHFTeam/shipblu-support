import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH } from '@/lib/categorise/normalise';
import { PRIORITIES } from '@/lib/tickets/vocabulary';
import { PRIORITY_QUESTION, hasCustomerText, priorityQuestion, priorityRequest } from './request';

/**
 * The question as it goes over the wire. A `choice` question keyed wrongly does
 * not fail — it answers over a vocabulary nobody meant — so its keys are
 * asserted against the enum the answer is written into.
 */

describe('priorityQuestion', () => {
  it('offers exactly the priority levels, in their declared order', () => {
    const question = priorityQuestion();
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria)).toEqual([...PRIORITIES]);
  });

  it('describes every level', () => {
    for (const text of Object.values(priorityQuestion().criteria)) {
      expect(text.length).toBeGreaterThan(40);
    }
  });

  it('names low as the answer for a message too vague to judge', () => {
    expect(priorityQuestion().instructions).toMatch(/Choose low when the message is too short/);
    expect(priorityQuestion().criteria.low).toMatch(/too short, vague or incomplete/);
  });
});

describe('priorityRequest', () => {
  const message = {
    channel: 'facebook',
    bodyText: 'هرفع قضية لو الفلوس موصلتش',
    earlier: ['فين فلوس التحصيل', 'بقالي اسبوع'],
  };

  it('files one question under the name the answer is read back by', () => {
    const request = priorityRequest(message, 'jev-latest', true);
    expect(Object.keys(request.questions)).toEqual([PRIORITY_QUESTION]);
    expect(request.model).toBe('jev-latest');
  });

  it('sends the earlier messages as their own field, not run into the message', () => {
    expect(priorityRequest(message, 'jev-latest', true).state).toEqual({
      channel: 'facebook',
      message: message.bodyText,
      earlier_messages_from_the_same_customer: message.earlier,
    });
  });

  it('sends the message alone when context is off', () => {
    expect(priorityRequest(message, 'jev-latest', false).state).toEqual({
      channel: 'facebook',
      message: message.bodyText,
    });
  });

  it('truncates at the categoriser’s cutoff, so both questions read the same text', () => {
    const long = { channel: 'email', bodyText: 'x'.repeat(MAX_TEXT_LENGTH + 50) };
    const state = priorityRequest(long, 'jev-latest', false).state as { message: string };
    expect(state.message).toHaveLength(MAX_TEXT_LENGTH);
  });
});

describe('hasCustomerText', () => {
  it('refuses the labels ingest writes for a message with no words', () => {
    for (const label of [
      '',
      '  ',
      '[image]',
      '[voice note]',
      '[sticker]',
      '[document: فاتورة.pdf]',
      '[2 attachments]',
      ' [video] ',
    ]) {
      expect(hasCustomerText(label), label).toBe(false);
    }
  });

  it('takes anything the customer wrote, a caption or a bracket included', () => {
    for (const text of ['؟', 'الشحنة [اتفتحت]', '[urgent] where is my COD', 'ok']) {
      expect(hasCustomerText(text), text).toBe(true);
    }
  });
});
