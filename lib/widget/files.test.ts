import { describe, expect, it } from 'vitest';
import {
  admitWidgetFiles,
  checkWidgetFiles,
  cleanFilename,
  declaredKind,
  MAX_WIDGET_FILE_BYTES,
  MAX_WIDGET_FILES,
  MAX_WIDGET_REQUEST_BYTES,
  MAX_WIDGET_TOTAL_BYTES,
  WIDGET_ACCEPT,
} from './files';

const MB = 1024 * 1024;
const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('declaredKind', () => {
  it.each([
    ['photo.jpg', 'image/jpeg', 'image'],
    ['IMG_0412.HEIC', 'image/heic', 'image'],
    ['invoice.pdf', 'application/pdf', 'document'],
    ['door.mov', 'video/quicktime', 'video'],
    ['door.mp4', 'video/mp4', 'video'],
    ['memo.m4a', 'audio/x-m4a', 'audio'],
    ['memo.m4a', 'audio/mp4', 'audio'],
    ['note.ogg', 'audio/ogg', 'audio'],
    ['note.mp3', 'audio/mpeg', 'audio'],
    ['note.wav', 'audio/wav', 'audio'],
    ['call.amr', 'audio/amr', 'audio'],
    ['clip.webm', 'audio/webm', 'audio'],
    // Firefox's own label for every .ogg, before it asks the system.
    ['voice.ogg', 'application/ogg', 'audio'],
    // What Windows' registry calls .aac, which Chrome, Edge and Firefox read there.
    ['recording.aac', 'audio/vnd.dlna.adts', 'audio'],
  ])('reads %s labelled %s as %s', (name, type, kind) => {
    expect(declaredKind({ name, type })).toBe(kind);
  });

  it('falls back to the extension when the browser gave no type, as Chrome does for HEIC', () => {
    expect(declaredKind({ name: 'IMG_0412.HEIC', type: '' })).toBe('image');
    expect(declaredKind({ name: 'call.amr', type: 'application/octet-stream' })).toBe('audio');
    expect(declaredKind({ name: 'voice.opus', type: '' })).toBe('audio');
  });

  it('believes the label over the name, so a page called photo.jpg is refused', () => {
    expect(declaredKind({ name: 'photo.jpg', type: 'text/html' })).toBeNull();
  });

  it.each([
    ['orders.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['notes.txt', 'text/plain'],
    ['logo.svg', 'image/svg+xml'],
    ['setup.exe', 'application/x-msdownload'],
    ['archive.zip', ''],
    ['README', ''],
  ])('refuses %s', (name, type) => {
    expect(declaredKind({ name, type })).toBeNull();
  });

  it('reads a type with parameters and in capitals by its essence', () => {
    expect(declaredKind({ name: 'x', type: 'Audio/OGG; codecs=opus' })).toBe('audio');
  });

  it('is not fooled by a prototype key as a type', () => {
    expect(declaredKind({ name: 'x', type: '__proto__' })).toBeNull();
    expect(declaredKind({ name: 'x.constructor', type: '' })).toBeNull();
  });
});

describe('admitWidgetFiles', () => {
  it('keeps every file that fits and names the first that does not', () => {
    const photos = [file('a.jpg', 'image/jpeg'), file('b.jpg', 'image/jpeg')];
    const video = file('door.mp4', 'video/mp4', MAX_WIDGET_FILE_BYTES + 1);

    const { admitted, refusal } = admitWidgetFiles([], [photos[0]!, video, photos[1]!]);

    expect(admitted).toEqual(photos);
    expect(refusal).toEqual({ reason: 'too_large', filename: 'door.mp4' });
  });

  it('adds to what is already chosen, up to the count', () => {
    const chosen = Array.from({ length: MAX_WIDGET_FILES - 1 }, (_, i) =>
      file(`${i}.jpg`, 'image/jpeg'),
    );
    const { admitted, refusal } = admitWidgetFiles(chosen, [
      file('last.jpg', 'image/jpeg'),
      file('over.jpg', 'image/jpeg'),
    ]);

    expect(admitted).toHaveLength(MAX_WIDGET_FILES);
    expect(admitted.at(-1)?.name).toBe('last.jpg');
    expect(refusal).toEqual({ reason: 'too_many' });
  });

  it('refuses a file that would take the message past its total', () => {
    const big = file('a.mp4', 'video/mp4', 20 * MB);
    const { admitted, refusal } = admitWidgetFiles([big], [file('b.mp4', 'video/mp4', 6 * MB)]);

    expect(admitted).toEqual([big]);
    expect(refusal).toEqual({ reason: 'too_large_total' });
  });

  it('refuses an empty file by name, rather than sending the words without it', () => {
    expect(admitWidgetFiles([], [file('memo.m4a', 'audio/x-m4a', 0)]).refusal).toEqual({
      reason: 'empty',
      filename: 'memo.m4a',
    });
  });

  it('names a refused type before anything else about it', () => {
    expect(admitWidgetFiles([], [file('huge.zip', 'application/zip', 90 * MB)]).refusal).toEqual({
      reason: 'type',
      filename: 'huge.zip',
    });
  });
});

describe('checkWidgetFiles', () => {
  it('passes what the composer would have admitted whole', () => {
    expect(checkWidgetFiles([file('a.jpg', 'image/jpeg'), file('b.pdf', 'application/pdf')])).toBe(
      null,
    );
  });

  it('refuses with the composer’s own reason', () => {
    expect(checkWidgetFiles([file('a.csv', 'text/csv')])).toEqual({
      reason: 'type',
      filename: 'a.csv',
    });
  });
});

describe('the limits', () => {
  it('stay under the body clone proxy.ts forces, with room for the text', async () => {
    // A clone over `proxyClientMaxBodySize` is truncated, not refused, so the
    // request limit must stay below it: read from the config itself, so
    // lowering it there fails here.
    const { default: config } = await import('@/next.config');
    const cap = Number(config.experimental?.proxyClientMaxBodySize);
    expect(cap).toBeGreaterThan(0);
    expect(MAX_WIDGET_REQUEST_BYTES).toBeLessThan(cap);
    expect(MAX_WIDGET_REQUEST_BYTES).toBeGreaterThan(MAX_WIDGET_TOTAL_BYTES);
    expect(MAX_WIDGET_FILE_BYTES).toBeLessThanOrEqual(MAX_WIDGET_TOTAL_BYTES);
  });

  it('offer the picker every family and the extensions a desktop cannot map', () => {
    const accepted = WIDGET_ACCEPT.split(',');
    expect(accepted).toEqual(
      expect.arrayContaining(['image/*', 'video/*', 'audio/*', 'application/pdf', '.heic', '.amr']),
    );
  });
});

describe('cleanFilename', () => {
  it('keeps an Arabic name as it was written', () => {
    expect(cleanFilename('صورة الشحنة.jpg', 'jpg')).toBe('صورة الشحنة.jpg');
  });

  it('removes the bidirectional override that draws one extension as another', () => {
    const spoofed = `invoice${String.fromCharCode(0x202e)}fdp.exe`;
    expect(cleanFilename(spoofed, 'pdf')).toBe('invoicefdp.exe');
  });

  it('removes control characters and caps the length', () => {
    expect(cleanFilename('a\u0000b\nc.pdf', 'pdf')).toBe('abc.pdf');
    expect(cleanFilename(`${'x'.repeat(400)}.pdf`, 'pdf')).toHaveLength(255);
  });

  it('removes what would break the subject or draw the name in the wrong order', () => {
    const name = [
      'inv',
      0x2028, // line separator
      'oi',
      0x2029, // paragraph separator
      'ce',
      0x061c, // Arabic letter mark
      0xfeff, // byte-order mark
      0x0085, // next line, a C1 control
      '.pdf',
    ]
      .map((part) => (typeof part === 'number' ? String.fromCharCode(part) : part))
      .join('');
    expect(cleanFilename(name, 'pdf')).toBe('invoice.pdf');
  });

  it('keeps the joiners a name in another script needs', () => {
    const persian = `می${String.fromCharCode(0x200c)}خواهم.pdf`;
    expect(cleanFilename(persian, 'pdf')).toBe(persian);
  });

  it('names a file that is left with nothing after its type', () => {
    expect(cleanFilename(String.fromCharCode(0x200f, 0x202e), 'm4a')).toBe('file.m4a');
    expect(cleanFilename('   ', 'jpg')).toBe('file.jpg');
  });
});
