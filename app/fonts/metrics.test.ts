import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/**
 * A self-hosted face that leads a font stack sets Safari's line metrics, so its
 * baseline must sit where the system font's would.
 *
 * WebKit before its safari-7625 branch takes the first family in a stack as
 * the line's primary font even when its `unicode-range` leaves the space out.
 * On an iPhone every console and widget line was laid out on 'Tajawal
 * Arabic''s ascent and descent, with Latin drawn in the system font on that
 * baseline. Fontsource's files give 643 / -357 / 200 per 1000, which put Latin
 * 0.235em high in its line box and every icon centred beside a label — a
 * status dot, a clock, a lock, a tick — 3px low (`app/globals.css`, above the
 * faces; docs/PROJECT-STATE.md §6.113).
 *
 * So this reads `globals.css` rather than a list of files. Any stack whose
 * first family is declared there is checked, face by face, wherever a face's
 * range leaves out U+0020, which is exactly when Safari and the spec disagree.
 * A face covering the space is the primary font in every browser, and a family
 * self-hosted nowhere here (Geist, the system font) leads nothing this reads.
 * A Tajawal file fresh from Fontsource, a new weight of it, or a new family put
 * at the head of a stack then fails CI rather than an iPhone.
 */

// -apple-system (.SFNS) per @capsizecss/metrics: ascent 1980, descent -432,
// line gap 0, at 2048 units per em.
const SYSTEM = { ascent: 1980, descent: -432, unitsPerEm: 2048 };

/**
 * Where a font puts the baseline below the middle of a line box, in ems:
 * half-leading plus the ascent is L/2 + (A + D)/2·S with D signed, so the
 * font's own part is (A + D)/2 — (A − |D|)/2.
 */
const baselineOffset = (ascent: number, descent: number, unitsPerEm: number) =>
  (ascent + descent) / 2 / unitsPerEm;

const SYSTEM_OFFSET = baselineOffset(SYSTEM.ascent, SYSTEM.descent, SYSTEM.unitsPerEm);

/**
 * How far a leading face may sit from the system font: under a pixel at any
 * size up to 20px. Rubik's Arabic faces, as shipped, are 0.035em away, half a
 * pixel at the 15px message size, and nobody has seen it; Fontsource's Tajawal
 * was 0.235em away, and everybody did.
 */
const TOLERANCE_EM = 0.05;

const APP = join(import.meta.dirname, '..');
const CSS = readFileSync(join(APP, 'globals.css'), 'utf8');

/** The first family of every `--font-*` stack, unquoted. */
function leadingFamilies(css: string): Set<string> {
  const families = new Set<string>();
  for (const [, stack] of css.matchAll(/--font-[\w-]+:\s*([^;{}]+);/g)) {
    families.add(
      stack!
        .split(',')[0]!
        .trim()
        .replace(/^['"]|['"]$/g, ''),
    );
  }
  return families;
}

type Face = { family: string; weight: string; file: string; range: string | null };

function faces(css: string): Face[] {
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
    family: /font-family:\s*['"]?([^'";]+)/.exec(body!)![1]!.trim(),
    weight: /font-weight:\s*([^;]+);/.exec(body!)?.[1]?.trim() ?? 'normal',
    file: /url\(['"]?\.\/([^'")]+)['"]?\)/.exec(body!)![1]!,
    range: /unicode-range:\s*([^;]+);/.exec(body!)?.[1] ?? null,
  }));
}

/** Whether a `unicode-range` covers the space; no range covers everything. */
function coversSpace(range: string | null): boolean {
  if (range === null) return true;
  return range.split(',').some((token) => {
    const [from, to = from] = token.trim().replace(/^U\+/i, '').split('-') as [string, string?];
    const lo = parseInt(from.replace(/\?/g, '0'), 16);
    const hi = parseInt(to.replace(/\?/g, 'F'), 16);
    return lo <= 0x20 && 0x20 <= hi;
  });
}

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

const leading = leadingFamilies(CSS);
const checked = faces(CSS).filter((face) => leading.has(face.family) && !coversSpace(face.range));

describe('a face leading a font stack', () => {
  it('is found: the stacks and their faces still read the way this parses them', () => {
    expect(leading).toContain('Tajawal Arabic');
    expect(checked.map((face) => face.family)).toContain('Tajawal Arabic');
  });

  it.each(checked)('$family $weight puts the baseline where the system font does', (face) => {
    const tables = woff2Tables(readFileSync(join(APP, face.file)));
    const head = tables.get('head')!;
    const hhea = tables.get('hhea')!;

    expect(head.readUInt32BE(12)).toBe(0x5f0f3cf5); // head's magic number: the slice is right
    expect(hhea.readUInt32BE(0)).toBe(0x00010000);

    const offset = baselineOffset(hhea.readInt16BE(4), hhea.readInt16BE(6), head.readUInt16BE(18));
    expect(Math.abs(offset - SYSTEM_OFFSET)).toBeLessThan(TOLERANCE_EM);
  });
});

describe('what the check reads', () => {
  it('takes a stack’s first family, quoted or not', () => {
    expect(
      leadingFamilies("--font-a: 'Tajawal Arabic', ui-sans-serif;\n--font-b: Geist, x;"),
    ).toEqual(new Set(['Tajawal Arabic', 'Geist']));
  });

  it('reads a range as covering the space only when one of its spans does', () => {
    expect(coversSpace('U+0600-06FF, U+200C-200E, U+204F')).toBe(false);
    expect(coversSpace('U+0000-00FF')).toBe(true);
    expect(coversSpace('U+0020')).toBe(true);
    expect(coversSpace('U+00??')).toBe(true);
    expect(coversSpace(null)).toBe(true);
  });

  it('measures Fontsource’s Tajawal, 643 / -357 per 1000, as 0.235em from the system font', () => {
    expect(SYSTEM_OFFSET - baselineOffset(643, -357, 1000)).toBeCloseTo(0.235, 3);
  });
});
