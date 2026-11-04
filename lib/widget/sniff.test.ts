import { describe, expect, it } from 'vitest';
import { sniffWidgetFile } from './sniff';

/**
 * The signatures, each built from the bytes the format's own specification
 * puts first, padded to a plausible header. What is asserted is what would be
 * stored: the type Storage serves the object as, and the kind the stand-in and
 * the thread read.
 */

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array([
    ...parts.flatMap((part) => (typeof part === 'string' ? ascii(part) : part)),
    ...new Array(32).fill(0),
  ]);

/** An ISO base media `ftyp` box: size, `ftyp`, major brand, minor version, compatible brands. */
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + compatible.length * 4;
  return bytes([0, 0, 0, size], 'ftyp', major, [0, 0, 0, 0], compatible.join(''));
};

describe('sniffWidgetFile', () => {
  it.each([
    ['a JPEG', bytes([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', 'image', 'jpg'],
    ['a PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png', 'image', 'png'],
    ['a GIF', bytes('GIF89a'), 'image/gif', 'image', 'gif'],
    ['a WebP', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'image/webp', 'image', 'webp'],
    ['an iPhone HEIC', ftyp('heic', 'mif1', 'heic'), 'image/heic', 'image', 'heic'],
    ['a HEIC led by the generic brand', ftyp('mif1', 'heic'), 'image/heic', 'image', 'heic'],
    ['an AVIF', ftyp('avif', 'mif1', 'miaf'), 'image/avif', 'image', 'avif'],
    ['a PDF', bytes('%PDF-1.7\n'), 'application/pdf', 'document', 'pdf'],
    ['an iPhone video', ftyp('qt  ', 'qt  '), 'video/quicktime', 'video', 'mov'],
    ['an MP4 video', ftyp('isom', 'isom', 'iso2', 'avc1', 'mp41'), 'video/mp4', 'video', 'mp4'],
    ['a 3GP video', ftyp('3gp4', 'isom', '3gp4'), 'video/3gpp', 'video', '3gp'],
    [
      'a WebM video',
      bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm'),
      'video/webm',
      'video',
      'webm',
    ],
    ['a voice memo', ftyp('M4A ', 'M4A ', 'mp42', 'isom'), 'audio/mp4', 'audio', 'm4a'],
    ['an Ogg voice note', bytes('OggS', [0, 2]), 'audio/ogg', 'audio', 'ogg'],
    ['an AMR recording', bytes('#!AMR\n'), 'audio/amr', 'audio', 'amr'],
    ['a tagged MP3', bytes('ID3', [4, 0]), 'audio/mpeg', 'audio', 'mp3'],
    ['an untagged MP3', bytes([0xff, 0xfb, 0x90, 0x64]), 'audio/mpeg', 'audio', 'mp3'],
    ['an ADTS AAC', bytes([0xff, 0xf1, 0x50, 0x80]), 'audio/aac', 'audio', 'aac'],
    ['a WAV', bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'audio/wav', 'audio', 'wav'],
  ])('reads %s', (_, head, contentType, kind, extension) => {
    expect(sniffWidgetFile(head, '')).toEqual({ contentType, kind, extension });
  });

  it('finds a PDF header a generator put after some bytes of its own', () => {
    expect(sniffWidgetFile(bytes(new Array(300).fill(0x20), '%PDF-1.4'), '')?.contentType).toBe(
      'application/pdf',
    );
  });

  describe('a container that holds sound as readily as a picture', () => {
    it('is audio when the browser labelled it audio', () => {
      expect(sniffWidgetFile(ftyp('isom', 'iso5', 'mp41'), 'audio/mp4')).toEqual({
        contentType: 'audio/mp4',
        kind: 'audio',
        extension: 'm4a',
      });
      expect(
        sniffWidgetFile(
          bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm'),
          'audio/webm;codecs=opus',
        ),
      ).toMatchObject({ contentType: 'audio/webm', kind: 'audio' });
      expect(sniffWidgetFile(ftyp('3gp4', '3gp4'), 'audio/3gpp')).toMatchObject({
        contentType: 'audio/3gpp',
        kind: 'audio',
      });
    });

    it('is video otherwise, whatever else the label claims', () => {
      expect(sniffWidgetFile(ftyp('mp42', 'mp42', 'isom'), 'image/jpeg')).toMatchObject({
        contentType: 'video/mp4',
        kind: 'video',
      });
    });
  });

  it('never stores the browser’s spelling, only its own', () => {
    // Labelled the way Chrome labels a voice memo, stored the way the
    // console's player list reads one.
    expect(sniffWidgetFile(ftyp('M4A ', 'M4A '), 'audio/x-m4a')?.contentType).toBe('audio/mp4');
  });

  it('reads a picture by its bytes, whatever the label said', () => {
    expect(sniffWidgetFile(bytes([0xff, 0xd8, 0xff, 0xe1]), 'application/pdf')).toMatchObject({
      kind: 'image',
      contentType: 'image/jpeg',
    });
  });

  it.each([
    ['an HTML page labelled as a photo', bytes('<!doctype html><script>')],
    ['an SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['a ZIP, which an Office file also is', bytes('PK', [3, 4])],
    ['a Windows program', bytes('MZ', [0x90, 0])],
    [
      'a Matroska video, which is not WebM by name',
      bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88], 'matroska'),
    ],
    ['an AVI, which is RIFF too', bytes('RIFF', [0, 0, 0, 0], 'AVI LIST')],
    ['plain text', bytes('where is my order')],
  ])('refuses %s', (_, head) => {
    expect(sniffWidgetFile(head, 'image/jpeg')).toBeNull();
  });

  it('refuses a file too short to carry any signature', () => {
    expect(sniffWidgetFile(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')).toBeNull();
    expect(sniffWidgetFile(new Uint8Array(), 'image/jpeg')).toBeNull();
  });
});
