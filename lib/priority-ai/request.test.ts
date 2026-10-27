import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH } from '@/lib/subcategorise/normalise';
import { PRIORITIES } from '@/lib/tickets/vocabulary';
import { PRIORITY_QUESTION, priorityQuestion, priorityRequest } from './request';

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

  it('truncates at the subcategoriser’s cutoff, so both questions read the same text', () => {
    const long = { channel: 'email', bodyText: 'x'.repeat(MAX_TEXT_LENGTH + 50) };
    const state = priorityRequest(long, 'jev-latest', false).state as { message: string };
    expect(state.message).toHaveLength(MAX_TEXT_LENGTH);
  });

  // Pinned as bytes, typed out rather than built by calling the code, because
  // priority is live in apply mode and nothing else measures whether its
  // answers move: a second classifier now asks about the same messages through
  // the same shared state, and a field added for that one, or a key order
  // changed while extracting, would change what this one is asked without any
  // other test noticing. `toEqual` ignores key order; `JSON.stringify` does not.
  // A comment channel goes out as its platform, as it did before comments had
  // channels of their own.
  it('sends exactly the bytes it sent before the category classifier existed', () => {
    const request = priorityRequest(
      { channel: 'facebook_comment', bodyText: message.bodyText, earlier: message.earlier },
      'jev-latest',
      true,
    );

    expect(JSON.stringify(request)).toBe(
      JSON.stringify({
        state: {
          channel: 'facebook',
          message: 'هرفع قضية لو الفلوس موصلتش',
          earlier_messages_from_the_same_customer: ['فين فلوس التحصيل', 'بقالي اسبوع'],
        },
        model: 'jev-latest',
        questions: {
          priority: {
            type: 'choice',
            instructions:
              'This is a message a customer sent to the support team of ShipBlu, a parcel delivery company in Egypt. The sender is either a merchant who ships parcels or a recipient expecting one. How urgently does the support team need to act on it? Judge the customer’s situation, not their tone: an angry message about an ordinary request is still ordinary. Messages are usually in Egyptian Arabic, sometimes in English, and sometimes in Franco-Arabic — Arabic written in Latin letters and digits. Choose low when the message is too short, too vague or too incomplete to judge; that is a real answer, not a last resort.',
            criteria: {
              low: 'A general question not about a specific parcel, a greeting, thanks or an acknowledgement — or a message too short, vague or incomplete to tell what the customer needs.',
              medium:
                'An ordinary request about a specific parcel, order or account: where a parcel is, rescheduling a delivery, changing an address or phone number, a question about a fee or a pickup.',
              high: 'Something has clearly gone wrong and the customer is waiting on us to fix it: a delivery that is overdue or has failed more than once, a return that is stuck, a damaged or wrong item, a merchant whose shipments are blocked, or a customer who is angry about having already contacted us before.',
              urgent:
                'Someone is losing money or is at risk right now: the customer threatens legal action, the police or a complaint to a regulator; reports fraud, theft or a parcel opened or tampered with; says cash-on-delivery money collected for them is missing; or threatens to go public about the company.',
            },
          },
        },
      }),
    );
    expect(request.state).not.toHaveProperty('is_public_comment');
  });
});
