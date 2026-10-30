import { describe, expect, it } from 'vitest';
import { permissionsForRole } from '@/lib/auth/permissions';
import { currentHref } from './current-href';
import {
  ADMIN_SECTIONS,
  canOpen,
  canOpenSettings,
  SETTINGS_PERMISSIONS,
  sectionsFor,
  type AdminSection,
} from './sections';

/**
 * The settings map decides what the sidebar offers, so what is pinned here is
 * who is shown which page: an admin every one, a supervisor none, and a single
 * per-agent grant exactly the pages that key opens. The `admin-sections` repo
 * rule holds each entry's key to the page's own check; this holds the filter.
 */

const admin = { role: 'admin' as const, permissions: {} };
const supervisor = { role: 'supervisor' as const, permissions: {} };

const hrefs = (sections: ReturnType<typeof sectionsFor>) =>
  sections.flatMap((section) =>
    section.pages.flatMap((page) => [page.href, ...(page.children ?? []).map((c) => c.href)]),
  );

const everyHref = ADMIN_SECTIONS.flatMap((section) =>
  section.pages.flatMap((page) => [page.href, ...(page.children ?? []).map((c) => c.href)]),
);

describe('the settings map', () => {
  it('names each page once, under /admin', () => {
    expect(new Set(everyHref).size).toBe(everyHref.length);
    for (const href of everyHref) expect(href).toMatch(/^\/admin\/[a-z-]+(\/[a-z-]+)*$/);
  });

  it('gates the area on settings keys only', () => {
    for (const key of SETTINGS_PERMISSIONS) expect(key).toMatch(/^admin\./);
  });

  it('shows an admin every page, since the role holds every key', () => {
    expect(hrefs(sectionsFor(admin)).sort()).toEqual([...everyHref].sort());
    for (const key of SETTINGS_PERMISSIONS) expect(permissionsForRole('admin')).toContain(key);
  });

  it('shows a supervisor nothing, and leaves no empty group behind', () => {
    expect(sectionsFor(supervisor)).toEqual([]);
  });

  it('shows a single grant exactly the pages its key opens', () => {
    const slaOnly = sectionsFor({ ...supervisor, permissions: { 'admin.sla': true } });

    expect(slaOnly.map((section) => section.title)).toEqual(['Workflows']);
    expect(hrefs(slaOnly)).toEqual(['/admin/sla', '/admin/hours']);
  });

  it('opens a page with an any-of key to whoever holds one of them', () => {
    const withoutFields = sectionsFor({ ...admin, permissions: { 'admin.fields': false } });

    expect(hrefs(withoutFields)).not.toContain('/admin/canned');
    expect(hrefs(withoutFields)).not.toContain('/admin/statuses');
    // Still reachable through the categories and subcategories keys.
    expect(hrefs(withoutFields)).toContain('/admin/ai');

    const subcategoriesOnly = sectionsFor({
      ...supervisor,
      permissions: { 'admin.subcategories': true },
    });
    expect(hrefs(subcategoriesOnly)).toEqual([
      '/admin/subcategories',
      '/admin/subcategories/review',
      '/admin/subcategories/shadow',
      '/admin/ai',
    ]);
  });

  it('drops a child page its key does not open, and keeps the parent', () => {
    // Every child on the real map shares its parent's key, so a fixture: a
    // parent either key opens, a child only one of them does, and an agent
    // holding the other.
    const map: AdminSection[] = [
      {
        title: 'Tickets',
        description: '',
        pages: [
          {
            href: '/admin/topics',
            label: 'Topics',
            permission: ['admin.fields', 'admin.sla'],
            description: '',
            keywords: [],
            children: [
              { href: '/admin/topics/review', label: 'Review', permission: 'admin.fields' },
              { href: '/admin/topics/hours', label: 'Hours', permission: 'admin.sla' },
            ],
          },
        ],
      },
    ];

    const [tickets] = sectionsFor({ ...supervisor, permissions: { 'admin.sla': true } }, map);

    expect(tickets?.pages.map((page) => page.href)).toEqual(['/admin/topics']);
    expect(tickets?.pages[0]?.children?.map((child) => child.href)).toEqual([
      '/admin/topics/hours',
    ]);
  });
});

describe('canOpen', () => {
  it('reads the key off the map, for a page or a child', () => {
    const slaOnly = { ...supervisor, permissions: { 'admin.sla': true } };

    expect(canOpen(slaOnly, '/admin/hours')).toBe(true);
    expect(canOpen(slaOnly, '/admin/groups')).toBe(false);
    expect(canOpen(admin, '/admin/subcategories/review')).toBe(true);
    expect(canOpen(supervisor, '/admin/subcategories/review')).toBe(false);
  });

  it('opens an any-of page to whoever holds one of its keys', () => {
    expect(canOpen({ ...supervisor, permissions: { 'admin.fields': true } }, '/admin/ai')).toBe(
      true,
    );
  });

  it('answers no for a page the map does not name', () => {
    expect(canOpen(admin, '/admin/nowhere')).toBe(false);
    expect(canOpen(admin, '/reports/live')).toBe(false);
  });

  it('lets in exactly whoever holds a key some page opens to', () => {
    expect(canOpenSettings(admin)).toBe(true);
    expect(canOpenSettings(supervisor)).toBe(false);
    expect(canOpenSettings({ ...supervisor, permissions: { 'admin.csat': true } })).toBe(true);
  });
});

describe('currentHref', () => {
  const nav = [
    {
      links: [
        { href: '/admin/sla', children: [] },
        {
          href: '/admin/subcategories',
          children: [{ href: '/admin/subcategories/review' }],
        },
      ],
    },
  ];

  it('lights the home only on the home', () => {
    expect(currentHref('/admin', nav)).toBe('/admin');
    expect(currentHref('/admin/sla', nav)).toBe('/admin/sla');
  });

  it('lights the most specific link, not every link the path starts with', () => {
    expect(currentHref('/admin/subcategories/review', nav)).toBe('/admin/subcategories/review');
    expect(currentHref('/admin/subcategories', nav)).toBe('/admin/subcategories');
  });

  it('keeps a page beneath a link inside it', () => {
    expect(currentHref('/admin/sla/42', nav)).toBe('/admin/sla');
  });

  it('compares whole segments', () => {
    expect(currentHref('/admin/slack', nav)).toBeNull();
  });
});
