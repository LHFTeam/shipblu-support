import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A luxon DateTime built with no zone reads in the host's: UTC in CI, Cairo on
 * the team's machines, where the day the clocks spring forward has no midnight
 * (§6.101). So every constructor names its zone, `now()` is read through one,
 * and the host's zone is not named by another spelling.
 */

/** Fifteen modules that import luxon and name their zone: the rule's floor. */
const LUXON = many(
  15,
  (i) => `lib/zoned${i}.ts`,
  (i) => `import { DateTime } from 'luxon';\n\nexport const at${i} = DateTime.utc();\n`,
);

/** A module importing luxon whose body is `lines`, the first on line 3. */
const luxon = (...lines) => `import { DateTime } from 'luxon';\n\n${lines.join('\n')}\n`;

const at = (line) => expect.objectContaining({ rule: 'luxon-zone', where: `lib/dates.ts:${line}` });

const run = (files) => runRule('luxon-zone', { ...LUXON, ...files });

describe('luxon-zone', () => {
  it('passes every spelling that names its zone', async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        "const zone = 'Africa/Cairo';",
        "export const a = DateTime.fromISO('2027-04-30', { zone: 'utc' });",
        'export const b = DateTime.fromISO(text, { zone });',
        "export const c = DateTime.fromJSDate(at, { zone: 'Africa/Cairo' }).toISODate();",
        'export const d = DateTime.fromObject({ year: 2026 }, { zone, locale: "en" });',
        "export const e = DateTime.fromFormat(text, 'yyyy-MM-dd', { zone: 'utc' });",
        'export const f = DateTime.local(2026, 4, 30, { zone });',
        "export const g = DateTime.now().setZone(zone).startOf('day');",
        'export const h = DateTime.now().toUTC().toISO();',
        'export const i = DateTime.utc(2026, 4, 30);',
        "export const j = DateTime.fromISO('2026-04-02T10:00:00Z', { 'zone': 'utc' });",
        // Prose about the rule, in the fixture, is not the rule broken.
        '// as in DateTime.fromISO(date), which reads the host zone',
        '/* nor is DateTime.now() in a block comment */',
        "export const k = 'DateTime.fromISO(date) in a string';",
        // A literal is still a literal wrapped, quoted or computed.
        "export const l = DateTime.fromISO(text, { zone: 'utc' } as const);",
        "export const m = DateTime.fromISO(text, ({ zone: 'utc' }));",
        "export const n = DateTime.fromISO(text, { ['zone']: 'utc' });",
        'export const o = DateTime.fromISO(text, { ...defaults, zone });',
        "export const p = DateTime.fromISO(text, { zone: cairo ? 'Africa/Cairo' : 'utc' });",
        'export const q = DateTime.now().setZone(zone, { keepLocalTime: false });',
      ),
      // Someone else's DateTime is not luxon's.
      'lib/other.ts':
        "import { DateTime } from './my-dates';\n\nexport const x = DateTime.fromISO(text);\n",
    });

    expect(found).toEqual([]);
  });

  it('refuses a constructor given no zone, and names its line', async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        "export const a = DateTime.fromISO('2027-04-30');",
        'export const b = DateTime.fromJSDate(at);',
        'export const c = DateTime.fromSeconds(1, undefined);',
      ),
    });

    expect(found).toEqual([at(3), at(4), at(5)]);
    expect(found[0].message).toMatch(/fromISO\(\) with no zone.*host's.*§6\.101/);
  });

  // The test this rule exists for, as it was.
  it('refuses the read that cost a Cairo laptop a day of the week', async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        "export const span = DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days;",
      ),
    });

    expect(found).toEqual([at(3), at(3)]);
  });

  it('refuses options that name no zone, or name the host by another spelling', async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        'export const a = DateTime.fromISO(text, { setZone: true });',
        'export const b = DateTime.fromISO(text, { ...options });',
        'export const c = DateTime.fromISO(text, options);',
        "export const d = DateTime.fromISO(text, { zone: 'local' });",
        'export const e = DateTime.fromJSDate(at, { zone: `system` });',
        "export const f = DateTime.fromISO(text, { zone: 'utc' }).setZone('local');",
        "export const g = DateTime.fromISO(text, { zone: 'utc' }).toLocal();",
      ),
    });

    expect(found).toEqual([at(3), at(4), at(5), at(6), at(7), at(8), at(9)]);
  });

  // luxon lowercases a zone's name, reads 'default' as the host's, and treats
  // a zone that is undefined or null as no zone at all.
  it("refuses the host's zone however luxon spells it", async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        "export const a = DateTime.fromISO(text, { zone: 'default' });",
        "export const b = DateTime.fromISO(text, { zone: 'Local' });",
        "export const c = DateTime.fromISO(text, { zone: 'utc' }).setZone('SYSTEM');",
        'export const d = DateTime.fromISO(text, { zone: undefined });',
        'export const e = DateTime.fromISO(text, { zone: null });',
        "export const f = DateTime.fromISO(text, { zone: cairo ? 'Africa/Cairo' : undefined });",
        'export const g = DateTime.fromISO(text, { zone: tz ?? undefined });',
        "export const h = DateTime.fromISO(text, { zone: 'utc' }).setZone();",
        "export const i = DateTime.fromISO(text, { zone: 'utc' }).setZone(undefined);",
        'export const j = DateTime.now().setZone();',
        "export const k = DateTime.fromISO(text, { zone: 'utc', ...options });",
        'export const l = DateTime.now().setZone(zone, { keepLocalTime: true });',
        'export const m = DateTime.now().toUTC(0, { keepCalendarTime: true });',
        'export const n = DateTime.fromFormatParser(text, parser);',
      ),
    });

    expect(found).toEqual(Array.from({ length: 14 }, (_, i) => at(3 + i)));
  });

  it('reads the options where each constructor takes them', async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        // A format string is not options; the zone goes third.
        "export const a = DateTime.fromFormat(text, 'yyyy-MM-dd');",
        "export const b = DateTime.fromString(text, 'yyyy-MM-dd');",
        'export const c = DateTime.local();',
        'export const d = DateTime.local(2026, 4, 30);',
      ),
    });

    expect(found).toEqual([at(3), at(4), at(5), at(6)]);
  });

  it("refuses now() read in the host's zone", async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        'export const a = DateTime.now();',
        'export const b = DateTime.now().toISODate();',
        "export const c = DateTime.now().startOf('day').setZone(zone);",
      ),
    });

    expect(found).toEqual([at(3), at(4), at(5)]);
  });

  it('sees a call across lines, and names the line it starts on', async () => {
    const found = await run({
      'lib/dates.ts': luxon(
        'export const a = DateTime.fromISO(',
        '  text,',
        '  { locale: "ar" },',
        ');',
      ),
    });

    expect(found).toEqual([at(3)]);
  });

  it('follows luxon under another name', async () => {
    const found = await run({
      'lib/aliased.ts':
        "import { DateTime as LuxonDateTime } from 'luxon';\n\nexport const a = LuxonDateTime.fromISO(text);\n",
      'lib/namespaced.ts':
        "import * as luxon from 'luxon';\n\nexport const a = luxon.DateTime.fromISO(text);\nexport const b = luxon.DateTime.fromISO(text, { zone: 'utc' });\n",
    });

    expect(found).toEqual([
      expect.objectContaining({ where: 'lib/aliased.ts:3' }),
      expect.objectContaining({ where: 'lib/namespaced.ts:3' }),
    ]);
  });

  it('follows every luxon import in a module, and holds one that imports no DateTime', async () => {
    const found = await run({
      'lib/both.ts':
        "import * as luxon from 'luxon';\nimport { DateTime } from 'luxon';\n\nexport const a = luxon.DateTime.fromISO(text);\nexport const b = DateTime.fromISO(text);\n",
      'lib/interval.ts':
        "import { Interval } from 'luxon';\n\nexport const a = (span: Interval) => span.start?.toLocal();\n",
    });

    expect(found).toEqual([
      expect.objectContaining({ where: 'lib/both.ts:4' }),
      expect.objectContaining({ where: 'lib/both.ts:5' }),
      expect.objectContaining({ where: 'lib/interval.ts:3' }),
    ]);
  });

  it('fails rather than passing when it finds too few modules importing luxon', async () => {
    const found = await runRule('luxon-zone', {
      'lib/dates.ts': luxon("export const a = DateTime.fromISO('2027-04-30');"),
    });

    expect(found).toEqual([
      at(3),
      expect.objectContaining({
        where: '(repository)',
        message: expect.stringContaining('checking nothing'),
      }),
    ]);
  });
});
