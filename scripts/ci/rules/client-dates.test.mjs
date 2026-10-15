import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A date drawn by a client component is drawn twice, by Node and by the
 * browser, and the punctuation of the engine's whole string is locale data
 * each ships its own copy of (§6.96). In the browser bundle a formatter is
 * built in `lib/format.ts`, which joins its fields, or chained straight into
 * `.formatToParts()`; the `toLocale*String` methods are refused outright.
 */

/** Twenty harmless client components: the rule's floor. */
const CLIENTS = many(
  20,
  (i) => `components/widget${i}.tsx`,
  (i) => `'use client';\n\nexport function Widget${i}() {\n  return null;\n}\n`,
);

const client = (body, imports = '') =>
  `'use client';\n\n${imports}export function Opens({ at }: { at: Date }) {\n${body}\n}\n`;

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
        message: expect.stringMatching(/whole string.*lib\/format\.ts/),
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

  it('passes the formatter chained into its parts, which the caller joins', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'components/opens.tsx': client(
        "  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit' }).formatToParts(at);\n  return parts.map((part) => part.value).join('');",
      ),
    });

    expect(found).toEqual([]);
  });

  it('refuses a formatter kept in a variable, whatever it is later asked for', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'components/opens.tsx': client(
        "  const format = Intl.DateTimeFormat('en-GB', { hour: '2-digit' });\n  return format.formatToParts(at)[0]?.value;",
      ),
    });

    expect(found).toEqual([expect.objectContaining({ where: 'components/opens.tsx:4' })]);
  });

  it('refuses the toLocale methods and a relative time worded by the engine', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'components/opens.tsx': client(
        [
          "  const day = at.toLocaleDateString('en-GB');",
          "  const time = at.toLocaleTimeString('en-GB');",
          '  const both = at.toLocaleString();',
          "  const ago = new Intl.RelativeTimeFormat('en').format(-3, 'minute');",
          '  return [day, time, both, ago].join();',
        ].join('\n'),
      ),
    });

    expect(found.map((failure) => failure.where)).toEqual([
      'components/opens.tsx:4',
      'components/opens.tsx:5',
      'components/opens.tsx:6',
      'components/opens.tsx:7',
    ]);
  });

  it('reads a type annotation, a comment and a string as what they are', async () => {
    const found = await runRule('client-dates', {
      ...CLIENTS,
      'components/opens.tsx': client(
        [
          '  // new Intl.DateTimeFormat().format(at) would differ between Node and the browser',
          '  let format: Intl.DateTimeFormat | null = null;',
          "  return format ? 'Intl.DateTimeFormat' : at.toISOString();",
        ].join('\n'),
      ),
    });

    expect(found).toEqual([]);
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
        '  return String(at);',
        "import { formatArticleDate } from '@/app/actions';\n\nvoid formatArticleDate;\n",
      ),
    });

    expect(found).toEqual([]);
  });
});
