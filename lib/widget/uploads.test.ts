import { describe, expect, it } from 'vitest';
import { megabytesOf, readVisitorUploads } from './uploads';

/**
 * The route's half of the file rules: the composer's own judgement, then the
 * bytes, read as the kind the file was admitted as.
 */

/** An MP4 container an Android recorder writes for a voice note: major brand `mp42`. */
const ANDROID_RECORDING = new Uint8Array([
  0,
  0,
  0,
  24,
  ...Array.from('ftypmp42', (c) => c.charCodeAt(0)),
  0,
  0,
  0,
  0,
  ...Array.from('isommp42', (c) => c.charCodeAt(0)),
  ...new Array(32).fill(0),
]);

describe('readVisitorUploads', () => {
  it('reads an unlabelled .m4a as the sound it was admitted as, not as a video', async () => {
    const file = new File([ANDROID_RECORDING], 'Voice 001.m4a', { type: '' });
    const read = await readVisitorUploads([file]);

    expect(read).toMatchObject({
      ok: true,
      uploads: [
        { filename: 'Voice 001.m4a', contentType: 'audio/mp4', kind: 'audio', extension: 'm4a' },
      ],
    });
  });

  it('reads the same container labelled as a video as a video', async () => {
    const file = new File([ANDROID_RECORDING], 'door.mp4', { type: 'video/mp4' });
    expect(await readVisitorUploads([file])).toMatchObject({
      ok: true,
      uploads: [{ contentType: 'video/mp4', kind: 'video' }],
    });
  });

  it('refuses an empty file by name before reading anything', async () => {
    const file = new File([], 'memo.m4a', { type: 'audio/x-m4a' });
    expect(await readVisitorUploads([file])).toEqual({
      ok: false,
      refusal: { reason: 'empty', filename: 'memo.m4a' },
    });
  });

  it('refuses a file whose bytes are none of the widget’s types, under its own name', async () => {
    const file = new File(['%!PS-Adobe-3.0 not a pdf at all'], 'invoice.pdf', {
      type: 'application/pdf',
    });
    expect(await readVisitorUploads([file])).toEqual({
      ok: false,
      refusal: { reason: 'type', filename: 'invoice.pdf' },
    });
  });
});

describe('megabytesOf', () => {
  const upload = (size: number) => ({
    filename: 'a',
    contentType: 'image/jpeg',
    kind: 'image' as const,
    extension: 'jpg',
    bytes: Buffer.alloc(size),
  });

  it('counts whole megabytes, rounded up, and never less than one', () => {
    expect(megabytesOf([upload(10)])).toBe(1);
    expect(megabytesOf([upload(1024 * 1024), upload(1)])).toBe(2);
    expect(megabytesOf([upload(5 * 1024 * 1024)])).toBe(5);
  });
});
