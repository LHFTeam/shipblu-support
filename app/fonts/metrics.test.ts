import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * The console's Arabic faces carry the system font's line metrics, not their
 * own.
 *
 * WebKit before its safari-7625 branch takes the first family in a stack as
 * the line's primary font even when its `unicode-range` leaves the space out,
 * so on an iPhone every line in the console and the widget is laid out on
 * 'Tajawal Arabic''s ascent and descent, and Latin text drawn in the system
 * font rides on that baseline. Fontsource's files give 643 / -357 / 200 per
 * 1000; that put Latin about 0.23em high in its line box, and every icon
 * centred beside a label — a status dot, a clock, a lock, a tick — 3px low
 * (`app/globals.css`, above the faces). The files in this directory are
 * Fontsource's with only `hhea` rewritten to -apple-system's, which is what
 * this holds them to: a fresh copy dropped in from Fontsource fails here,
 * where the phone would only have looked slightly wrong.
 */

// -apple-system (.SFNS) per @capsizecss/metrics: ascent 1980, descent -432,
// line gap 0, at 2048 units per em. Tajawal is drawn at 1000.
const SYSTEM = { ascent: 1980, descent: -432, lineGap: 0, unitsPerEm: 2048 };
const EXPECTED = {
  ascent: Math.round((SYSTEM.ascent * 1000) / SYSTEM.unitsPerEm),
  descent: Math.round((SYSTEM.descent * 1000) / SYSTEM.unitsPerEm),
  lineGap: 0,
};

const TAJAWAL = [
  'tajawal-arabic-400.woff2',
  'tajawal-arabic-500.woff2',
  'tajawal-arabic-700.woff2',
];

/**
 * WOFF2's known-table tags, in the order its table directory indexes them
 * (W3C WOFF2 §5.1); index 63 means the tag follows as four bytes.
 */
// prettier-ignore
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

/**
 * The untransformed tables of a single-font WOFF2, by tag.
 *
 * Enough of the format to read `head` and `hhea`, which WOFF2 never
 * transforms: walk the directory for each table's length in the stream — its
 * transformed length where it has one — and slice the one Brotli stream they
 * are stored in, back to back, in directory order.
 */
function woff2Tables(file: Buffer): Map<string, Buffer> {
  if (file.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  if (file.toString('latin1', 4, 8) === 'ttcf') throw new Error('a collection is not read here');

  const numTables = file.readUInt16BE(12);
  const compressedLength = file.readUInt32BE(20);
  let at = 48;

  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = file[at++]!;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('UIntBase128 longer than five bytes');
  };

  const directory: { tag: string; length: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[at++]!;
    const index = flags & 0x3f;
    const tag = index === 63 ? file.toString('latin1', at, (at += 4)) : KNOWN_TAGS[index]!;
    const version = flags >> 6;
    const original = base128();
    // glyf and loca are transformed at version 0, every other table at any
    // version but 0; only a transformed table carries a second length.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    directory.push({ tag, length: transformed ? base128() : original });
  }

  const stream = brotliDecompressSync(file.subarray(at, at + compressedLength));
  const tables = new Map<string, Buffer>();
  let offset = 0;
  for (const { tag, length } of directory) {
    tables.set(tag, stream.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== stream.length) throw new Error('table lengths do not add up to the stream');
  return tables;
}

describe('the Arabic faces under the console stack', () => {
  it.each(TAJAWAL)('%s carries the system font’s line metrics', (name) => {
    const tables = woff2Tables(readFileSync(join(process.cwd(), 'app/fonts', name)));
    const head = tables.get('head')!;
    const hhea = tables.get('hhea')!;

    expect(head.readUInt32BE(12)).toBe(0x5f0f3cf5); // head's magic number: the slice is right
    expect(head.readUInt16BE(18)).toBe(1000);
    expect(hhea.readUInt32BE(0)).toBe(0x00010000);
    expect({
      ascent: hhea.readInt16BE(4),
      descent: hhea.readInt16BE(6),
      lineGap: hhea.readInt16BE(8),
    }).toEqual(EXPECTED);
  });
});
