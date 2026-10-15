import { describe, expect, it } from 'vitest';
import { parseMetaWebhook } from '@/lib/meta/parse';
import { displayText } from '@/lib/whatsapp/parse';
import {
  PLACEHOLDER,
  UNNAMED_SUBJECT,
  WHITESPACE,
  WRAPPED_LABEL,
  hasCustomerText,
  lastCustomerWords,
  subjectWords,
} from './customer-text';
import { subjectFrom } from './ingest-whatsapp';

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
      '[empty comment]',
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

  // A file's name, a pin's address and Meta's reason come from elsewhere, and
  // a bracket or a line break in one is not ours to have closed the label.
  it('refuses a label round a string that holds a bracket or a line break', () => {
    for (const label of [
      '[document: فاتورة [1].pdf]',
      '[location: برج القاهرة\nالزمالك (30.0459, 31.2243)]',
      '[location (30.0459, 31.2243)]',
      '[unsupported message: Message type [x] is not supported]',
      '[unsupported message type: a\nb]',
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
      { type: 'document', document: { id: '1', filename: 'فاتورة [1].pdf' } },
      { type: 'sticker', sticker: { id: '1' } },
      { type: 'location', location: { latitude: 30.04, longitude: 31.23 } },
      {
        type: 'location',
        location: { latitude: 30.04, longitude: 31.23, name: 'برج القاهرة', address: 'الزمالك' },
      },
      {
        type: 'location',
        location: {
          latitude: 30.04,
          longitude: 31.23,
          name: 'Hub [B]',
          address: '12 Tahrir\nDokki',
        },
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
      { type: 'unsupported', errors: [{ code: 131051, title: 'Message [x] is not supported' }] },
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

describe('lastCustomerWords', () => {
  const row = (bodyText: string, extra: Record<string, unknown> = {}) => ({
    direction: 'inbound',
    kind: 'reply',
    meta: {} as unknown,
    bodyText,
    ...extra,
  });

  // The page's half of the pick `requesterLocale` makes: the newest words, not
  // the first, and nothing that only looks like the newest message.
  it('takes the newest inbound reply that carries the customer’s words', () => {
    const timeline = [
      row('الشحنة وصلت مكسورة'),
      row('my parcel arrived broken'),
      row('[image]', { meta: { whatsappType: 'image' } }),
      row('[reacted 🙏]', { meta: { whatsappType: 'reaction' } }),
      row('thanks', { meta: { whatsappType: 'reaction' } }),
      row('[edited a message: broken\nbadly]', { meta: { whatsappType: 'edit' } }),
      row('\n'),
      row('we are on it', { direction: 'outbound' }),
      row('checked with the hub', { kind: 'note' }),
    ];

    expect(lastCustomerWords(timeline)?.bodyText).toBe('my parcel arrived broken');
  });

  it('finds nothing in a timeline with no words of the customer’s own', () => {
    expect(lastCustomerWords([row('[voice note]'), row('[2 attachments]')])).toBeUndefined();
    expect(lastCustomerWords([])).toBeUndefined();
  });
});

describe('subjectWords', () => {
  // A chat ticket's subject is its opening message's first line.
  it('keeps a subject somebody wrote and drops one that is our label', () => {
    expect(subjectWords('فين شحنتي')).toBe('فين شحنتي');
    expect(subjectWords('Re: [SB-1234] where is my order')).toBe('Re: [SB-1234] where is my order');
    expect(subjectWords('[voice note]')).toBeNull();
    expect(subjectWords('[image]')).toBeNull();
    expect(subjectWords(null)).toBeNull();
  });

  // Made into a subject the way ingest makes one: the first line, cut to 80.
  it('drops a wrapped label cut short of its bracket, and keeps words that only open like one', () => {
    const base = { id: 'wamid.1', from: '201000000000', timestamp: '1' };
    const pin = displayText({
      ...base,
      type: 'location',
      location: {
        latitude: 30.0284,
        longitude: 31.4086,
        name: 'ShipBlu Hub',
        address: 'Cairo Festival City Mall, Ring Road, New Cairo, Cairo Governorate',
      },
    } as never);
    const edit = displayText({
      ...base,
      type: 'edit',
      edit: {
        original_message_id: 'wamid.0',
        message: { ...base, type: 'text', text: { body: 'بكرة الساعة 10\nمش النهارده' } },
      },
    } as never);
    const document = displayText({
      ...base,
      type: 'document',
      document: { id: '1', filename: `${'بوليصة الشحن '.repeat(8)}.pdf` },
    } as never);

    for (const label of [pin, edit, document]) {
      const subject = subjectFrom(label);
      expect(subject.endsWith(']'), subject).toBe(false);
      expect(subjectWords(subject), subject).toBeNull();
    }
    expect(subjectWords('[urgent] where is my COD')).toBe('[urgent] where is my COD');
    expect(subjectWords('[document] missing from my parcel')).toBe(
      '[document] missing from my parcel',
    );
  });

  it('drops the name ingest gives a ticket whose opening message has no first line', () => {
    expect(subjectWords(subjectFrom(''))).toBeNull();
    for (const name of Object.values(UNNAMED_SUBJECT)) expect(subjectWords(name), name).toBeNull();
    expect(subjectWords('Facebook comment about my order')).toBe('Facebook comment about my order');
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
    expect(WRAPPED_LABEL.flags).toBe('s');
  });
});
