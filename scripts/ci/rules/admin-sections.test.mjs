import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * The settings map draws every way into the settings area and says which key
 * opens each page, so it is held to the pages: every page on it, every entry a
 * page, each entry's key the one its page requires, and no href twice.
 */

const REGISTRY = 'app/(console)/admin/sections.ts';

/** A page whose guard is `guard`, called on line 4. */
const page = (guard) =>
  `import { requireAnyPermission, requirePermission } from '@/lib/auth/guard';\n\nexport default async function Page() {\n  const agent = await ${guard};\n  return <div>{agent.name}</div>;\n}\n`;

const entry = (href, permission, rest = '') =>
  `{ href: '${href}', label: 'Page', permission: ${permission}${rest} }`;

/** A map of one group holding `entries`, the first on line 5. */
const registry = (...entries) =>
  [
    "import type { AdminSection } from './types';",
    '',
    'export const ADMIN_SECTIONS: readonly AdminSection[] = [',
    "  { title: 'Team', description: 'Who works here.', pages: [",
    ...entries.map((text) => `    ${text},`),
    '  ] },',
    '];',
    '',
  ].join('\n');

/** Fifteen pages and their entries: the rule's floor, so a case is only its own change. */
const AREAS = Array.from({ length: 15 }, (_, i) => entry(`/admin/area${i}`, `'admin.area${i}'`));
const PAGES = many(
  15,
  (i) => `app/(console)/admin/area${i}/page.tsx`,
  (i) => page(`requirePermission('admin.area${i}')`),
);

/** The settings home opens on any key the map names, and is on no map. */
const HOME = { 'app/(console)/admin/page.tsx': page('requireAnyPermission(SETTINGS_PERMISSIONS)') };

/** The line an entry added after the fifteen lands on. */
const ADDED = `${REGISTRY}:20`;

const run = ({ entries = [], pages = {}, areas = AREAS } = {}) =>
  runRule('admin-sections', {
    ...PAGES,
    ...HOME,
    [REGISTRY]: registry(...areas, ...entries),
    ...pages,
  });

describe('admin-sections', () => {
  it('passes a map that matches its pages, and leaves the settings home off it', async () => {
    expect(await run()).toEqual([]);
  });

  it('reads a child, an any-of key in any order, and a page inside a route group', async () => {
    const found = await run({
      entries: [
        entry(
          '/admin/topics',
          "'admin.topics'",
          ", children: [{ href: '/admin/topics/review', label: 'Review', permission: 'admin.topics' }]",
        ),
        entry('/admin/ai', "['admin.categories', 'admin.fields'] as const"),
        entry('/admin/skills', "'admin.skills'"),
      ],
      pages: {
        'app/(console)/admin/topics/page.tsx': page("requirePermission('admin.topics')"),
        'app/(console)/admin/topics/review/page.tsx': page("requirePermission('admin.topics')"),
        'app/(console)/admin/ai/page.tsx': page(
          "requireAnyPermission(['admin.fields', 'admin.categories'])",
        ),
        'app/(console)/admin/(team)/skills/page.tsx': page("requirePermission('admin.skills')"),
      },
    });

    expect(found).toEqual([]);
  });

  it('refuses a page that is not on the map', async () => {
    const found = await run({
      pages: { 'app/(console)/admin/orphan/page.tsx': page("requirePermission('admin.area0')") },
    });

    expect(found).toEqual([
      expect.objectContaining({
        rule: 'admin-sections',
        where: 'app/(console)/admin/orphan/page.tsx',
        message: expect.stringMatching(/^\/admin\/orphan is not on the settings map/),
      }),
    ]);
  });

  it('refuses an entry no page serves', async () => {
    const found = await run({ entries: [entry('/admin/ghost', "'admin.ghost'")] });

    expect(found).toEqual([
      expect.objectContaining({
        where: ADDED,
        message: expect.stringMatching(/^\/admin\/ghost has no page/),
      }),
    ]);
  });

  it('refuses a page that requires another key, and names both', async () => {
    const found = await run({
      pages: { 'app/(console)/admin/area3/page.tsx': page("requirePermission('admin.other')") },
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/area3/page.tsx:4',
        message: expect.stringMatching(
          /registered under 'admin\.area3', but its page calls requirePermission\('admin\.other'\)/,
        ),
      }),
    ]);
  });

  it('counts only the guard: not can() for a control, not a key in a comment', async () => {
    const found = await run({
      pages: {
        'app/(console)/admin/area3/page.tsx': [
          "import { requireAgent } from '@/lib/auth/guard';",
          "// await requirePermission('admin.area3');",
          'export default async function Page() {',
          '  const agent = await requireAgent();',
          "  return can(agent, 'admin.area3') ? <div /> : null;",
          '}',
          '',
        ].join('\n'),
      },
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/area3/page.tsx',
        message: expect.stringMatching(
          /'admin\.area3', but its page calls neither requirePermission nor requireAnyPermission/,
        ),
      }),
    ]);
  });

  it('refuses a second guard naming another key', async () => {
    const found = await run({
      pages: {
        'app/(console)/admin/area3/page.tsx': page(
          "requirePermission('admin.area3');\n  await requirePermission('admin.sla')",
        ),
      },
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/area3/page.tsx:5',
        message: expect.stringMatching(/requirePermission\('admin\.sla'\)/),
      }),
    ]);
  });

  it('holds an any-of key to the same set, and to the any-of guard', async () => {
    const found = await run({
      entries: [
        entry('/admin/fewer', "['admin.categories', 'admin.fields']"),
        entry('/admin/single', "['admin.categories', 'admin.fields']"),
        entry('/admin/listed', "'admin.categories'"),
      ],
      pages: {
        'app/(console)/admin/fewer/page.tsx': page("requireAnyPermission(['admin.categories'])"),
        'app/(console)/admin/single/page.tsx': page("requirePermission('admin.categories')"),
        'app/(console)/admin/listed/page.tsx': page("requireAnyPermission(['admin.categories'])"),
      },
    });

    // In the order git lists the pages.
    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/fewer/page.tsx:4',
        message: expect.stringMatching(
          /\['admin\.categories', 'admin\.fields'\], but its page calls requireAnyPermission\(\['admin\.categories'\]\)/,
        ),
      }),
      expect.objectContaining({
        where: 'app/(console)/admin/listed/page.tsx:4',
        message: expect.stringMatching(
          /registered under 'admin\.categories', but its page calls requireAnyPermission/,
        ),
      }),
      expect.objectContaining({
        where: 'app/(console)/admin/single/page.tsx:4',
        message: expect.stringMatching(/its page calls requirePermission\('admin\.categories'\)/),
      }),
    ]);
  });

  it('refuses a guard whose key it cannot read', async () => {
    const found = await run({
      pages: { 'app/(console)/admin/area3/page.tsx': page('requirePermission(KEY)') },
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/area3/page.tsx:4',
        message: expect.stringMatching(
          /calls requirePermission\(KEY\), which admin-sections cannot read/,
        ),
      }),
    ]);
  });

  it('refuses an href registered twice, and points at both', async () => {
    const found = await run({ entries: [entry('/admin/area0', "'admin.area0'")] });

    expect(found).toEqual([
      expect.objectContaining({
        where: ADDED,
        message: expect.stringMatching(/^\/admin\/area0 is registered twice \(first on line 5\)/),
      }),
    ]);
  });

  it.each([
    ['a key in a variable', entry('/admin/odd', 'ODD_KEY'), /permission is `ODD_KEY`/],
    [
      'a key list holding a variable',
      entry('/admin/odd', "['admin.odd', KEY]"),
      /neither a quoted key/,
    ],
    ['an empty key list', entry('/admin/odd', '[]'), /neither a quoted key/],
    ['no key at all', "{ href: '/admin/odd', label: 'Odd' }", /has no permission on its entry/],
    ['a key and no href', "{ label: 'Odd', permission: 'admin.odd' }", /a permission and no href/],
    [
      'a computed href',
      "{ href: `/admin/${slug}`, label: 'Odd', permission: 'admin.odd' }",
      /an href written as/,
    ],
    ['an entry in a variable', 'ODD_PAGE', /`pages` holds `ODD_PAGE`, not an entry/],
    ['entries spread in', '...MORE_PAGES', /`pages` holds `\.\.\.MORE_PAGES`, not an entry/],
  ])('refuses an entry it cannot read rather than passing it: %s', async (_, text, message) => {
    const found = await run({
      entries: [text],
      pages: { 'app/(console)/admin/odd/page.tsx': page("requirePermission('admin.odd')") },
    });

    expect(found).toContainEqual(
      expect.objectContaining({
        where: ADDED,
        message: expect.stringMatching(message),
      }),
    );
    for (const failure of found.filter((f) => f.where === ADDED)) {
      expect(failure.message).toMatch(/the map is read as written, not run/);
    }
  });

  it('refuses a child opened by a key its parent is not', async () => {
    const found = await run({
      entries: [
        entry(
          '/admin/topics',
          "'admin.topics'",
          ", children: [{ href: '/admin/topics/review', label: 'Review', permission: 'admin.review' }]",
        ),
        entry(
          '/admin/tags',
          "['admin.tags', 'admin.topics']",
          ", children: [{ href: '/admin/tags/merge', label: 'Merge', permission: 'admin.tags' }]",
        ),
      ],
      pages: {
        'app/(console)/admin/topics/page.tsx': page("requirePermission('admin.topics')"),
        'app/(console)/admin/topics/review/page.tsx': page("requirePermission('admin.review')"),
        'app/(console)/admin/tags/page.tsx': page(
          "requireAnyPermission(['admin.tags', 'admin.topics'])",
        ),
        'app/(console)/admin/tags/merge/page.tsx': page("requirePermission('admin.tags')"),
      },
    });

    // The second child's key is one of its parent's, so its holders see both.
    expect(found).toEqual([
      expect.objectContaining({
        where: ADDED,
        message: expect.stringMatching(
          /\/admin\/topics\/review opens to 'admin\.review', which its parent \/admin\/topics does not/,
        ),
      }),
    ]);
  });

  it('refuses a dynamic segment by name rather than matching it literally', async () => {
    const found = await run({
      pages: {
        'app/(console)/admin/area0/[id]/page.tsx': page("requirePermission('admin.area0')"),
      },
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/area0/[id]/page.tsx',
        message: expect.stringMatching(/the segment '\[id\]' is dynamic, parallel or intercepting/),
      }),
    ]);
  });

  it('fails when the map cannot be found', async () => {
    const found = await runRule('admin-sections', {
      ...PAGES,
      [REGISTRY]: 'export const SECTIONS = [];\n',
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: REGISTRY,
        message: expect.stringMatching(/could not find `export const ADMIN_SECTIONS/),
      }),
    ]);
  });

  it('fails when it reads too few entries to be checking anything', async () => {
    const found = await run({ areas: AREAS.slice(0, 3) });

    expect(found).toEqual([
      expect.objectContaining({
        where: REGISTRY,
        message: expect.stringMatching(/found only 3 settings pages registered in ADMIN_SECTIONS/),
      }),
    ]);
  });
});
