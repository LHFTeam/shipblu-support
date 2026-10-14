import { describe, expect, it } from 'vitest';
import { parseMetaWebhook } from '@/lib/meta/parse';
import { displayText } from '@/lib/whatsapp/parse';
import { EDIT_LABEL, PLACEHOLDER, WHITESPACE, hasCustomerText } from './customer-text';

/**
 * Which stored messages are somebody's words. The query's half,
 * `carriesCustomerText`, is held to these answers by
 * `carries-customer-text.db.test.ts`; what is tested here is the rule, the
 * labels it has to recognise, and the two facts about its constants that the
 * query depends on and Postgres cannot check.
 */

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
      '\n[image]\n',
      '\u00A0[voice note]\u3000',
    ]) {
      expect(hasCustomerText(label), label).toBe(false);
    }
  });

  it('refuses a WhatsApp edit, however its words are laid out', () => {
    for (const label of [
      '[edited a message]',
      '[edited a message: Tomorrow at 10]',
      '[edited a message: بكرة الساعة 10\nمش النهارده]',
      '[edited a message: see [the photo] again]',
      '[edited a message: one\r\ntwo\u2028three]',
    ]) {
      expect(hasCustomerText(label), label).toBe(false);
    }
  });

  it('takes anything the customer wrote, a caption or a bracket included', () => {
    for (const text of ['؟', 'الشحنة [اتفتحت]', '[urgent] where is my COD', 'ok', '[one\ntwo]']) {
      expect(hasCustomerText(text), text).toBe(true);
    }
  });

  // From the parsers rather than typed out, so a label of a shape the rule does
  // not know fails here instead of reading as the customer's English.
  it('refuses every label the WhatsApp parser writes for a message with no words', () => {
    const base = { id: 'wamid.1', from: '201000000000', timestamp: '1' };
    const wordless: Record<string, unknown>[] = [
      { type: 'image', image: { id: '1' } },
      { type: 'video', video: { id: '1' } },
      { type: 'audio', audio: { id: '1' } },
      { type: 'audio', audio: { id: '1', voice: true } },
      { type: 'document', document: { id: '1' } },
      { type: 'document', document: { id: '1', filename: 'فاتورة.pdf' } },
      { type: 'sticker', sticker: { id: '1' } },
      { type: 'location', location: { latitude: 30.04, longitude: 31.23 } },
      {
        type: 'location',
        location: { latitude: 30.04, longitude: 31.23, name: 'برج القاهرة', address: 'الزمالك' },
      },
      { type: 'contacts', contacts: [{}, {}] },
      { type: 'reaction', reaction: { message_id: 'wamid.0', emoji: '🙏' } },
      { type: 'button', button: {} },
      { type: 'interactive', interactive: {} },
      { type: 'order', order: {} },
      { type: 'system', system: {} },
      { type: 'media_placeholder' },
      { type: 'revoke', revoke: { original_message_id: 'wamid.0' } },
      { type: 'edit', edit: { original_message_id: 'wamid.0' } },
      {
        type: 'edit',
        edit: {
          original_message_id: 'wamid.0',
          message: { ...base, type: 'text', text: { body: 'بكرة الساعة 10\nمش النهارده' } },
        },
      },
      { type: 'unsupported', errors: [{ code: 131051, title: 'Message type is not supported' }] },
      { type: 'unsupported' },
    ];

    for (const message of wordless) {
      const label = displayText({ ...base, ...message } as never);
      expect(hasCustomerText(label), label).toBe(false);
    }
  });

  it('refuses every label the Meta parser writes for a message with no words', () => {
    const attachment = (type: string) => ({ type, payload: { url: 'https://cdn.example/1' } });
    const wordless: Record<string, unknown>[] = [
      ...['image', 'video', 'audio', 'file', 'share', 'story_mention', 'sticker'].map((type) => ({
        attachments: [attachment(type)],
      })),
      { attachments: [attachment('image'), attachment('image')] },
      { is_unsupported: true },
    ];

    for (const message of wordless) {
      const parsed = parseMetaWebhook(
        {
          object: 'page',
          entry: [
            {
              id: '111222333',
              messaging: [
                {
                  sender: { id: 'psid-1' },
                  recipient: { id: '111222333' },
                  timestamp: 1_755_000_000_000,
                  message: { mid: 'm_1', ...message },
                },
              ],
            },
          ],
        },
        'facebook_page',
      );
      const label = parsed.messages[0]?.text ?? '';
      expect(label).toMatch(/^\[/);
      expect(hasCustomerText(label), label).toBe(false);
    }
  });
});

describe('the constants the query is built from', () => {
  // Postgres's `btrim` is handed `WHITESPACE` where this module calls `trim()`,
  // so a character in one set and not the other is a body the twins disagree
  // about. Every code point, because the claim is "exactly".
  it('name exactly the characters String.prototype.trim removes', () => {
    const trimmed: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const character = String.fromCodePoint(code);
      if (`${character}x`.trim() === 'x') trimmed.push(character);
    }

    expect([...WHITESPACE]).toEqual(trimmed);
  });

  // `source` is what reaches Postgres, and it carries no flag: `s` is the one
  // that makes JavaScript's `.` match a line break as Postgres's always does,
  // and any other would be a difference only one side applies.
  it('carry no flag but the one Postgres behaves as if it had', () => {
    expect(PLACEHOLDER.flags).toBe('');
    expect(EDIT_LABEL.flags).toBe('s');
  });
});
