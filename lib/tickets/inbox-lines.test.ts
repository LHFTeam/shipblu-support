import { describe, expect, it } from 'vitest';
import { messageLines } from './inbox-lines';

describe('messageLines', () => {
  it('shows only the last message where the subject is the opening message', () => {
    expect(
      messageLines({ channel: 'whatsapp', subject: 'وين شحنتي؟', preview: 'Booked for tomorrow' }),
    ).toEqual({ headline: 'Booked for tomorrow', secondary: null });
  });

  it('falls back to the subject on empty text, which is what body_text holds, not null', () => {
    expect(messageLines({ channel: 'instagram', subject: 'Pickup request', preview: '' })).toEqual({
      headline: 'Pickup request',
      secondary: null,
    });
    expect(messageLines({ channel: 'facebook', subject: null, preview: null })).toEqual({
      headline: '(no subject)',
      secondary: null,
    });
  });

  it('keeps a written subject above the last message', () => {
    expect(
      messageLines({ channel: 'email', subject: 'Where is my order?', preview: 'Thanks!' }),
    ).toEqual({ headline: 'Where is my order?', secondary: 'Thanks!' });
    expect(messageLines({ channel: 'portal', subject: 'Refund', preview: 'Any news?' })).toEqual({
      headline: 'Refund',
      secondary: 'Any news?',
    });
  });

  it('does not say a written subject twice when the message is only the subject', () => {
    expect(messageLines({ channel: 'email', subject: 'Refund', preview: 'Refund' })).toEqual({
      headline: 'Refund',
      secondary: null,
    });
    expect(messageLines({ channel: 'email', subject: '', preview: '' })).toEqual({
      headline: '(no subject)',
      secondary: null,
    });
  });
});
