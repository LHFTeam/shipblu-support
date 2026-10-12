'use client';

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

type DetailsTab<Id extends string> = { id: Id; label: string; panel: ReactNode };

/**
 * The details column's tabs: Shipments, Conversation, Contact.
 *
 * Every panel stays mounted and the inactive ones are `hidden`, for the reason
 * the composer and the knowledge panel give for doing the same: a panel can
 * hold something half-done — a tag being typed, a tracking number not yet
 * saved, a refusal the agent has not read — and moving to another tab to check
 * a parcel must not throw it away. `[hidden]` is `display: none !important`
 * under Tailwind's preflight, so no class on a panel can bring it back.
 *
 * The keyboard is the WAI-ARIA tabs pattern with automatic activation: one tab
 * stop for the row, the arrow keys move along it and select as they go, Home
 * and End jump to the ends. In a right-to-left page the arrows follow the
 * reading direction, so → moves toward the start.
 */
export function DetailsTabs<Id extends string>({
  tabs,
  initial,
}: {
  tabs: DetailsTab<Id>[];
  /** The tab shown first. Not remembered: every ticket opens on its own default. */
  initial: Id;
}) {
  const [active, setActive] = useState<Id>(initial);
  const base = useId();
  const buttons = useRef(new Map<Id, HTMLButtonElement>());

  const tabId = (id: Id) => `${base}-tab-${id}`;
  const panelId = (id: Id) => `${base}-panel-${id}`;

  function select(id: Id) {
    setActive(id);
    buttons.current.get(id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === active);
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];

    let next: number | null = null;
    if (step !== undefined) next = (index + step + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;

    event.preventDefault();
    select(tabs[next]!.id);
  }

  return (
    <>
      <div
        role="tablist"
        aria-label="Details"
        onKeyDown={onKeyDown}
        // Stays put while the panel under it scrolls, so changing tab never
        // means scrolling back up to find the row.
        className="sticky top-0 z-10 flex gap-1 border-b border-(--color-border-subtle) bg-(--color-background-surface) px-3"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) buttons.current.set(tab.id, node);
                else buttons.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              // The blue underline is the marker for "where you are" across the
              // console; the weight change says it again without the colour.
              className={`px-2 py-2.5 text-sm transition-colors ${
                selected
                  ? 'font-semibold text-(--color-text-primary) shadow-[inset_0_-2px_0_var(--color-action-primary-default)]'
                  : 'text-(--color-text-secondary) hover:text-(--color-text-primary)'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={panelId(tab.id)}
          aria-labelledby={tabId(tab.id)}
          hidden={tab.id !== active}
        >
          {tab.panel}
        </div>
      ))}
    </>
  );
}
