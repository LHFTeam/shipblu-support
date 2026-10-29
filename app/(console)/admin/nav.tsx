'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useEffect, useRef } from 'react';
import { currentHref } from './sections';

/**
 * The settings sidebar, drawn from `sections.ts` by the layout, which has
 * already left out what this agent cannot open.
 *
 * On a phone it becomes a horizontally scrolling strip rather than a menu
 * behind a button: hiding the destinations behind a tap makes finding a
 * setting a two-step search. There are twenty-odd of them now, so the strip
 * keeps a hairline between groups and scrolls the current page into view,
 * where it would otherwise start off the edge of the screen.
 */

export type NavLink = { href: string; label: string };
export type NavSection = {
  title: string;
  links: (NavLink & { children: NavLink[] })[];
};

/*
 * The design system's views-panel item: the section you are in wears the
 * selected tint with brand text, never a filled blue, because a filled blue is
 * what an action looks like. `aria-current` is the hook for the styling as well
 * as the fact for a screen reader, so the two cannot disagree.
 */
const ITEM =
  'flex min-h-9 items-center rounded-md px-2 text-sm text-(--color-text-primary) transition-colors hover:bg-(--color-background-hover) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)';

const CHILD =
  'flex min-h-8 items-center rounded-md ps-5 pe-2 text-xs text-(--color-text-secondary) transition-colors hover:bg-(--color-background-hover) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)';

const CHIP =
  'rounded-full bg-(--color-background-surface-sunken) px-3 py-1 text-xs whitespace-nowrap text-(--color-text-secondary) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)';

export function AdminNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const current = currentHref(pathname, sections);
  const strip = useRef<HTMLElement>(null);

  // The strip is wider than any phone, and the page you are on is as likely to
  // be its twentieth chip as its first.
  useEffect(() => {
    strip.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [current]);

  const mark = (href: string) => (href === current ? ('page' as const) : undefined);

  return (
    <>
      <nav
        aria-label="Settings sections"
        className="app-scroll relative hidden w-(--views-width) shrink-0 flex-col gap-4.5 overflow-y-auto border-e border-(--color-border-subtle) bg-(--color-background-surface) px-2.5 py-4 lg:flex"
      >
        <Link href="/admin" aria-current={mark('/admin')} className={`${ITEM} font-semibold`}>
          Settings
        </Link>

        {sections.map((section) => (
          <div key={section.title} role="group" aria-label={section.title}>
            <p className="mb-1 px-2 text-xs font-semibold text-(--color-text-secondary)">
              {section.title}
            </p>
            <ul className="flex flex-col gap-0.5">
              {section.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} aria-current={mark(link.href)} className={ITEM}>
                    {link.label}
                  </Link>
                  {link.children.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {link.children.map((child) => (
                        <li key={child.href}>
                          <Link href={child.href} aria-current={mark(child.href)} className={CHILD}>
                            {child.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Pinned under the console header, and clear of the rail from `md`,
          where the rail appears and this strip is still showing. */}
      <nav
        ref={strip}
        aria-label="Settings sections"
        className="app-scroll fixed inset-x-0 top-(--header-height) z-20 flex items-center gap-1 overflow-x-auto border-b border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2 md:start-(--rail-width) lg:hidden"
      >
        <Link href="/admin" aria-current={mark('/admin')} className={`${CHIP} font-semibold`}>
          Settings
        </Link>
        {sections.map((section) => (
          <Fragment key={section.title}>
            <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-(--color-border-subtle)" />
            {section.links
              .flatMap((link) => [link, ...link.children])
              .map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={mark(link.href)}
                  className={CHIP}
                >
                  {link.label}
                </Link>
              ))}
          </Fragment>
        ))}
      </nav>
    </>
  );
}
