import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A date drawn by a client component is drawn twice, by Node and by the
 * browser, and the punctuation of the engine's whole string is locale data
 * each ships its own copy of (§6.96). In the browser bundle `Intl.DateTimeFormat`
 * lives only in `lib/format.ts`, which joins its fields; the engine's own date
 * strings — `toLocale*String`, `toDateString`, luxon's relative words and
 * localized macros — are refused everywhere, that module included.
 */

/** Twenty harmless client components: the rule's floor. */
const CLIENTS = many(
  20,
  (i) => `components/widget${i}.tsx`,
  (i) => `'use client';\n\nexport function Widget${i}() {\n  return null;\n}\n`,
);

const client = (body, imports = '') =>
  `'use client';\n\n${imports}export function Opens({ at }: { at: Date }) {\n${body}\n}\n`;

/** One line per case, each at the line the client's body starts on. */
async function refusedLines(...lines) {
  const found = await runRule('client-dates', {
    ...CLIENTS,
    'components/opens.tsx': client([...lines, '  return null;'].join('\n')),
  });
  return found.map((failure) => failure.where);
}

describe('client-dates', () => {
  it('passes a client component that formats through lib/format.ts', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'lib/format.ts':
        "const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });\n\nexport function formatDay(at: Date) {\n  return day.format(at);\n}\n",
      'components/opens.tsx': client(
        '  return formatDay(at);',
        "import { formatDay } from '@/lib/format';\n\n",
      ),
    });

    expect(found).toEqual([]);
  });

  it('refuses a whole-string format in a client component, and names the line', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'components/opens.tsx': client(
        "  return new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(at);",
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'components/opens.tsx:4',
        message: expect.stringMatching(/outside lib\/format\.ts.*punctuation/),
      }),
    ]);
  });

  it('refuses one in a module the bundle reaches for something else, and names the route', async () => {
    // The `lib/kb/locale.ts` shape: the client takes `t()`, and a date
    // formatter only a server page calls rides along with it.
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'lib/kb/locale.ts':
        "export const t = (key: string) => key;\n\nexport function formatArticleDate(at: Date) {\n  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(at);\n}\n",
      'components/opens.tsx': client(
        "  return t('opens');",
        "import { t } from '@/lib/kb/locale';\n\n",
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'lib/kb/locale.ts:4',
        message: expect.stringContaining('through components/opens.tsx → lib/kb/locale.ts'),
      }),
    ]);
  });

  it('follows a barrel, which brings every module it re-exports into the bundle', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'lib/kb/index.ts':
        "export const t = (key: string) => key;\nexport * from './dates';\nexport type { Shape } from './shape';\n",
      'lib/kb/dates.ts':
        "export function formatArticleDate(at: Date) {\n  return at.toLocaleDateString('en-GB');\n}\n",
      // Type-only, so erased: nothing in it is in the bundle.
      'lib/kb/shape.ts':
        'export type Shape = { at: Date };\nexport const whole = (at: Date) => at.toLocaleString();\n',
      'components/opens.tsx': client("  return t('opens');", "import { t } from '@/lib/kb';\n\n"),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'lib/kb/dates.ts:2',
        message: expect.stringContaining(
          'components/opens.tsx → lib/kb/index.ts → lib/kb/dates.ts',
        ),
      }),
    ]);
  });

  it('refuses a formatter chained into its parts, which can rebuild the whole string', async () => {
    // Joined from the engine's own literals, this is `.format(at)` again; only
    // reading what the caller keeps of the parts could tell, which is why the
    // formatter lives in one module rather than being judged at each use.
    expect(
      await refusedLines(
        "  new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).formatToParts(at).map((p) => p.value).join('');",
      ),
    ).toEqual(['components/opens.tsx:4']);
  });

  it('refuses the formatter however it is spelled', async () => {
    expect(
      await refusedLines(
        "  Intl.DateTimeFormat('en-GB', { hour: '2-digit' });",
        "  new globalThis.Intl.DateTimeFormat('en-GB').format(at);",
        "  new Intl['DateTimeFormat']('en-GB').format(at);",
        '  const { DateTimeFormat } = Intl;',
        '  class Formatter extends Intl.DateTimeFormat {}',
        "  Intl.DateTimeFormat.supportedLocalesOf(['ar-EG']);",
      ),
    ).toEqual([
      'components/opens.tsx:4',
      'components/opens.tsx:5',
      'components/opens.tsx:6',
      'components/opens.tsx:7',
      'components/opens.tsx:8',
      'components/opens.tsx:9',
    ]);
  });

  it("refuses the engine's own date strings and relative words", async () => {
    expect(
      await refusedLines(
        "  at.toLocaleDateString('en-GB');",
        "  at.toLocaleTimeString('en-GB');",
        '  at.toLocaleString();',
        '  at.toDateString();',
        '  at.toTimeString();',
        "  new Intl.RelativeTimeFormat('en').format(-3, 'minute');",
      ),
    ).toEqual([
      'components/opens.tsx:4',
      'components/opens.tsx:5',
      'components/opens.tsx:6',
      'components/opens.tsx:7',
      'components/opens.tsx:8',
      'components/opens.tsx:9',
    ]);
  });

  it('holds luxon to the same: no relative words, no localized macro', async () => {
    expect(
      await refusedLines(
        '  DateTime.fromJSDate(at).toRelative();',
        '  DateTime.fromJSDate(at).toRelativeCalendar();',
        "  DateTime.fromJSDate(at).toFormat('DDD');",
        "  DateTime.fromJSDate(at).toFormat('ccc, t');",
        // Fields spelled out, with the separators in the pattern: joined.
        '  DateTime.fromJSDate(at).toFormat("cccc \'at\' HH:mm");',
        // Quoted text is literal in luxon, so a quoted 'D' is not a macro.
        '  DateTime.fromJSDate(at).toFormat("\'Day\' d");',
      ),
    ).toEqual([
      'components/opens.tsx:4',
      'components/opens.tsx:5',
      'components/opens.tsx:6',
      'components/opens.tsx:7',
    ]);
  });

  it('keeps the formatter in lib/format.ts and nothing else', async () => {
    // The module that joins fields may build a formatter, but the engine's own
    // strings are as wrong there as anywhere else in the bundle.
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'lib/format.ts': [
        "const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });",
        'export const formatDay = (at: Date) => day.format(at);',
        "export const formatShort = (at: Date) => at.toLocaleDateString('en-GB');",
        "export const formatAgo = (n: number) => new Intl.RelativeTimeFormat('en').format(n, 'minute');",
        '',
      ].join('\n'),
      'components/opens.tsx': client(
        '  return formatDay(at) + formatShort(at) + formatAgo(3);',
        "import { formatAgo, formatDay, formatShort } from '@/lib/format';\n\n",
      ),
    });

    expect(found.map((failure) => failure.where)).toEqual(['lib/format.ts:3', 'lib/format.ts:4']);
  });

  it('counts a relative time only in <RelativeTime>, which waits for hydration', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'lib/format.ts':
        'export function formatRelative(value: Date, now: Date) {\n  return `${now.getTime() - value.getTime()}`;\n}\n',
      'components/relative-time.tsx':
        "'use client';\n\nimport { formatRelative } from '@/lib/format';\n\nexport function RelativeTime({ at, now }: { at: Date; now: Date }) {\n  return formatRelative(at, now);\n}\n",
      // A client component handed a clock it read itself: the server's and the
      // browser's, a moment apart.
      'components/opens.tsx': client(
        '  return formatRelative(at, new Date());',
        "import { formatRelative } from '@/lib/format';\n\n",
      ),
      // A server page reads its clock once, and only the server draws it.
      'app/page.tsx':
        "import { formatRelative } from '@/lib/format';\n\nexport default function Page() {\n  return formatRelative(new Date(0), new Date());\n}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'components/opens.tsx:6',
        message: expect.stringContaining('render <RelativeTime> from components/relative-time.tsx'),
      }),
    ]);
  });

  it('reads a type annotation, a comment and a string as what they are', async () => {
    expect(
      await refusedLines(
        '  // new Intl.DateTimeFormat().format(at) would differ between Node and the browser',
        '  let format: Intl.DateTimeFormat | null = null;',
        '  type Options = Intl.DateTimeFormatOptions & { zone: typeof Intl.DateTimeFormat };',
        '  interface Formatter extends Intl.DateTimeFormat {}',
        "  const label = format ? 'Intl.DateTimeFormat' : at.toISOString();",
      ),
    ).toEqual([]);
  });

  it('leaves a module no client component reaches, and stops at a server action', async () => {
    const whole =
      "export function formatArticleDate(at: Date) {\n  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(at);\n}\n";
    const found = await runRule('client-dates', {
      ...CLIENTS,
      // A server page's own formatter: drawn once, by the server.
      'lib/kb/dates.ts': whole,
      'app/page.tsx':
        "import { formatArticleDate } from '@/lib/kb/dates';\n\nexport default function Page() {\n  return formatArticleDate(new Date());\n}\n",
      // An action file the client calls: Next swaps it for a fetch.
      'app/actions.ts': `'use server';\n\n${whole}`,
      'components/opens.tsx': client(
        '  return at.toISOString();',
        "import { formatArticleDate } from '@/app/actions';\n\nvoid formatArticleDate;\n",
      ),
    });

    expect(found).toEqual([]);
  });
});
