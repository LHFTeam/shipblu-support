/**
 * The one sidebar link that is "here": the longest whose path the current one is
 * or sits under, compared by whole segment. Prefix matching alone lit
 * Subcategories and Review queue together on the review page, and `/admin/sla`
 * must not light up for a page at `/admin/slack`.
 *
 * A module of its own, importing nothing, because the sidebar that asks it is a
 * client component: beside the map in `sections.ts` it shipped every page's
 * description and search words, and the permission tables, to every settings
 * page, which the layout trims the sidebar's props to avoid.
 */
export function currentHref(
  pathname: string,
  sections: readonly {
    links: readonly { href: string; children: readonly { href: string }[] }[];
  }[],
): string | null {
  if (pathname === '/admin') return '/admin';
  let best: string | null = null;
  for (const section of sections) {
    for (const link of section.links.flatMap((item) => [item, ...item.children])) {
      const inside = pathname === link.href || pathname.startsWith(`${link.href}/`);
      if (inside && (best === null || link.href.length > best.length)) best = link.href;
    }
  }
  return best;
}
