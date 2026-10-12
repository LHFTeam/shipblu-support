import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ViewIcon } from '@/lib/tickets/inbox-views';
import { channelInfo } from './channel';
import { CheckIcon, ClockIcon, InboxIcon, ListIcon, UserIcon } from './icons';
import { CountBadge } from './ui';

export type ViewsPanelItem = {
  id: string;
  label: string;
  href: string;
  icon?: ViewIcon;
  /** Draws the channel's mark instead of an icon. */
  channel?: string;
  count?: number;
  /** The coral count instead of a plain number. */
  attention?: boolean;
};

export type ViewsPanelSection = { title: string | null; items: ViewsPanelItem[] };

const ICONS: Record<ViewIcon, (props: { size: number; className: string }) => ReactNode> = {
  user: UserIcon,
  inbox: InboxIcon,
  list: ListIcon,
  clock: ClockIcon,
  check: CheckIcon,
};

/**
 * The column of saved views beside a list: Mine, Unassigned, All, the
 * channels, the statuses.
 *
 * Links rather than buttons, and no client code: every view is a URL the list
 * already understands, so choosing one is a navigation that works before the
 * page's script has loaded, and a view can be middle-clicked into a tab of its
 * own.
 *
 * Counts are plain text except where `attention` asks for the coral one — an
 * unassigned ticket is waiting on somebody to take it, and coral means exactly
 * that and nothing else. An item with no count has none drawn: the panel shows
 * no number it was not given.
 */
export function ViewsPanel({
  title,
  sections,
  active,
  footer,
}: {
  title: string | null;
  sections: ViewsPanelSection[];
  active: string | null;
  footer?: ReactNode;
}) {
  return (
    <nav aria-label={title ?? 'Views'} className="flex flex-col gap-[18px] px-2.5 py-4">
      {title ? <h2 className="px-2 text-base leading-6 font-semibold">{title}</h2> : null}

      {sections.map((section, index) => (
        <div
          key={section.title ?? index}
          role="group"
          aria-label={section.title ?? undefined}
          className="flex flex-col gap-0.5"
        >
          {section.title ? (
            <p className="mb-1 px-2 text-xs leading-4 font-semibold text-(--color-text-secondary)">
              {section.title}
            </p>
          ) : null}

          {section.items.map((item) => {
            const Icon = item.icon ? ICONS[item.icon] : null;

            return (
              <Link
                key={item.id}
                href={item.href}
                prefetch={false}
                aria-current={item.id === active ? 'page' : undefined}
                className="group flex min-h-9 items-center gap-2.5 rounded-md px-2 text-sm leading-5 text-(--color-text-primary) transition-colors hover:bg-(--color-background-hover) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)"
              >
                {item.channel ? (
                  <span
                    aria-hidden
                    // `border` because the bot's dashed edge is a style and a
                    // colour that draw nothing without a width.
                    className={`flex size-4.5 flex-none items-center justify-center rounded-sm border ${channelInfo(item.channel).className}`}
                  >
                    {channelInfo(item.channel).mark}
                  </span>
                ) : Icon ? (
                  <Icon
                    size={18}
                    className="shrink-0 text-(--color-text-secondary) group-aria-[current=page]:text-current"
                  />
                ) : null}

                <span className="min-w-0 flex-1 truncate">{item.label}</span>

                {item.count === undefined ? null : item.attention ? (
                  <CountBadge count={item.count} label="conversations" />
                ) : (
                  <span className="flex-none text-xs leading-4 font-medium text-(--color-text-secondary) tabular-nums group-aria-[current=page]:text-(--color-text-brand)">
                    {item.count}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}

      {footer}
    </nav>
  );
}
