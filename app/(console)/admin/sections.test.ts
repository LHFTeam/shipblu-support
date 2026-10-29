import { describe, expect, it } from 'vitest';
import { permissionsForRole } from '@/lib/auth/permissions';
import { ADMIN_SECTIONS, currentHref, SETTINGS_PERMISSIONS, sectionsFor } from './sections';

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
    const [tickets] = sectionsFor({
      ...supervisor,
      permissions: { 'admin.subcategories': true },
    });

    expect(tickets?.pages[0]?.children?.map((child) => child.label)).toEqual([
      'Review queue',
      'Shadow runs',
    ]);
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
