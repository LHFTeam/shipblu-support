import { describe, expect, it } from 'vitest';
import { parseMetaWebhook } from '@/lib/meta/parse';
import { parseWebhook } from '@/lib/whatsapp/parse';
import { isMediaStandIn, mediaLooks } from './message-media';

/**
 * The stand-ins are produced by the two parsers, and the thread recognises them
 * by rebuilding them from what ingest stores. Each case here therefore runs a
 * real webhook through the real parser and stores what ingest stores, so a
 * parser that changes its wording fails this file rather than leaving the
 * thread drawing a line it was meant to hide.
 */

const FILE = { id: 'file-1' };

/** A WhatsApp media message as `inboundRow` in `lib/tickets/ingest-whatsapp.ts` stores it. */
function whatsAppRow(message: Record<string, unknown>, files = [FILE]) {
  const parsed = parseWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '201000000000', phone_number_id: '1234' },
              messages: [
                { id: 'wamid.1', from: '201001234567', timestamp: '1755500000', ...message },
              ],
            },
          },
        ],
      },
    ],
  }).messages[0]!;

  return {
    bodyText: parsed.text,
    bodyHtml: null,
    meta: {
      whatsappType: parsed.type,
      ...(parsed.media
        ? {
            media: {
              mediaId: parsed.media.mediaId,
              mimeType: parsed.media.mimeType,
              filename: parsed.media.filename,
              isVoice: parsed.media.isVoice,
              downloaded: files.length > 0,
            },
          }
        : {}),
    },
    attachments: files,
  };
}

/** A Messenger direct message as `lib/tickets/ingest-meta.ts` stores it. */
function metaRow(message: Record<string, unknown>, files = [FILE]) {
  const parsed = parseMetaWebhook(
    {
      object: 'page',
      entry: [
        {
          id: 'page-1',
          time: 1_755_000_000_000,
          messaging: [
            {
              sender: { id: 'psid-1' },
              recipient: { id: 'page-1' },
              timestamp: 1_755_000_000_000,
              message: { mid: 'm_1', ...message },
            },
          ],
        },
      ],
    },
    'facebook_page',
  ).messages[0]!;

  return {
    bodyText: parsed.text,
    bodyHtml: null,
    meta: { metaKind: 'direct_message', attachments: parsed.attachments },
    attachments: files,
  };
}

const sent = (type: string) => ({ type, payload: { url: `https://cdn.example/${type}` } });

describe('isMediaStandIn', () => {
  it.each([
    ['a photo', { type: 'image', image: { id: '1', mime_type: 'image/jpeg' } }, '[image]'],
    ['a video', { type: 'video', video: { id: '1', mime_type: 'video/mp4' } }, '[video]'],
    ['a sticker', { type: 'sticker', sticker: { id: '1', mime_type: 'image/webp' } }, '[sticker]'],
    [
      'a voice note',
      { type: 'audio', audio: { id: '1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
      '[voice note]',
    ],
    ['an audio file', { type: 'audio', audio: { id: '1', mime_type: 'audio/mpeg' } }, '[audio]'],
    [
      'a named document',
      {
        type: 'document',
        document: { id: '1', mime_type: 'application/pdf', filename: 'awb.pdf' },
      },
      '[document: awb.pdf]',
    ],
    [
      'a document whose name has a bracket in it',
      { type: 'document', document: { id: '1', filename: 'awb [1].pdf' } },
      '[document: awb [1].pdf]',
    ],
    ['an unnamed document', { type: 'document', document: { id: '1' } }, '[document]'],
  ])('recognises the stand-in for %s on WhatsApp', (_, message, text) => {
    const row = whatsAppRow(message);
    expect(row.bodyText).toBe(text);
    expect(isMediaStandIn(row)).toBe(true);
  });

  it('recognises a business-app echo the same way, since it is stored the same way', () => {
    const row = whatsAppRow({ type: 'image', image: { id: '1' } });
    expect(isMediaStandIn({ ...row, meta: { ...row.meta, echo: true } })).toBe(true);
  });

  it.each(['image', 'video', 'audio', 'file', 'sticker'])(
    'recognises the stand-in for one %s on Messenger',
    (type) => {
      const row = metaRow({ attachments: [sent(type)] });
      expect(row.bodyText).toBe(`[${type}]`);
      expect(isMediaStandIn(row)).toBe(true);
    },
  );

  it('recognises a count once every file it counts has arrived', () => {
    const row = metaRow({ attachments: [sent('image'), sent('image')] }, [FILE, { id: 'file-2' }]);
    expect(row.bodyText).toBe('[2 attachments]');
    expect(isMediaStandIn(row)).toBe(true);
  });

  it('keeps a count when one of the files never arrived', () => {
    const row = metaRow({ attachments: [sent('image'), sent('image')] }, [FILE]);
    expect(isMediaStandIn(row)).toBe(false);
  });

  it('keeps a caption, which is the customer speaking', () => {
    const row = whatsAppRow({ type: 'image', image: { id: '1', caption: 'الكرتونة متبهدلة' } });
    expect(isMediaStandIn(row)).toBe(false);
  });

  it('keeps a caption that happens to be bracketed, even one naming the type', () => {
    expect(
      isMediaStandIn(
        whatsAppRow({ type: 'image', image: { id: '1', caption: '[urgent] where is my COD' } }),
      ),
    ).toBe(false);
    // A caption is never rebuilt, so one that reads exactly like a stand-in for
    // another type is still the customer's.
    expect(
      isMediaStandIn(whatsAppRow({ type: 'video', video: { id: '1', caption: '[image]' } })),
    ).toBe(false);
  });

  it('keeps words that say where a file came from', () => {
    for (const type of ['story_mention', 'share', 'story', 'ig_reel', 'reel', 'fallback']) {
      const row = metaRow({ attachments: [sent(type)] });
      expect(row.bodyText).toBe(`[${type}]`);
      expect(isMediaStandIn(row)).toBe(false);
    }
  });

  it('keeps a Messenger message the platform could not describe', () => {
    const row = metaRow({ is_unsupported: true, attachments: [sent('image')] });
    expect(row.bodyText).toBe('[unsupported message type]');
    expect(isMediaStandIn(row)).toBe(false);
  });

  it('keeps the words while nothing is drawn in their place', () => {
    // Still downloading, failed to download, or a copied chat's file, which the
    // copy never carries: the words are the only sign anything was sent.
    expect(isMediaStandIn(whatsAppRow({ type: 'image', image: { id: '1' } }, []))).toBe(false);
    expect(isMediaStandIn(metaRow({ attachments: [sent('image')] }, []))).toBe(false);
    expect(
      isMediaStandIn({
        bodyText: '[media]',
        bodyHtml: null,
        meta: { whatsappType: 'media_placeholder', mediaPlaceholder: true },
        attachments: [],
      }),
    ).toBe(false);
  });

  it('never touches a message whose text nothing generated', () => {
    // An email or a form: what looks like a stand-in was typed by somebody.
    expect(
      isMediaStandIn({ bodyText: '[image]', bodyHtml: null, meta: {}, attachments: [FILE] }),
    ).toBe(false);
    expect(
      isMediaStandIn({
        bodyText: '[image]',
        bodyHtml: '<p>[image]</p>',
        meta: { whatsappType: 'image' },
        attachments: [FILE],
      }),
    ).toBe(false);
    expect(
      isMediaStandIn({ bodyText: '[image]', bodyHtml: null, meta: null, attachments: [FILE] }),
    ).toBe(false);
  });

  it('reads a damaged meta as nothing generated rather than throwing', () => {
    expect(
      isMediaStandIn({
        bodyText: '[document]',
        bodyHtml: null,
        meta: { whatsappType: 'document', media: 'x' },
        attachments: [FILE],
      }),
    ).toBe(true);
    expect(
      isMediaStandIn({
        bodyText: '[image]',
        bodyHtml: null,
        meta: { metaKind: 'direct_message', attachments: [null] },
        attachments: [FILE],
      }),
    ).toBe(false);
  });
});

describe('mediaLooks', () => {
  it('names a WhatsApp sticker, which its type cannot tell from a photo', () => {
    const row = whatsAppRow({ type: 'sticker', sticker: { id: '1', mime_type: 'image/webp' } });
    expect(mediaLooks(row).get(FILE.id)).toBe('sticker');
  });

  it('names a Messenger voice clip as sound, though it arrives as a video', () => {
    expect(mediaLooks(metaRow({ attachments: [sent('audio')] })).get(FILE.id)).toBe('sound');
    expect(mediaLooks(metaRow({ attachments: [sent('sticker')] })).get(FILE.id)).toBe('sticker');
  });

  it('names a WhatsApp voice note as sound', () => {
    const row = whatsAppRow({ type: 'audio', audio: { id: '1', voice: true } });
    expect(mediaLooks(row).get(FILE.id)).toBe('sound');
  });

  it('says nothing about a photo, which its type already describes', () => {
    expect(mediaLooks(whatsAppRow({ type: 'image', image: { id: '1' } })).size).toBe(0);
    expect(mediaLooks(metaRow({ attachments: [sent('image')] })).size).toBe(0);
  });

  it('says nothing when the files cannot be paired with what the sender said', () => {
    const two = [FILE, { id: 'file-2' }];
    expect(mediaLooks(metaRow({ attachments: [sent('audio'), sent('audio')] }, two)).size).toBe(0);
    // Two sent, one arrived: which one is not recorded anywhere the thread reads.
    expect(mediaLooks(metaRow({ attachments: [sent('audio'), sent('image')] }, [FILE])).size).toBe(
      0,
    );
    expect(mediaLooks({ meta: { whatsappType: 'sticker' }, attachments: [] }).size).toBe(0);
  });
});
