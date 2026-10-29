'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SearchInput } from '@/components/search-input';
import { Badge } from '@/components/ui';

/**
 * Every settings page, grouped as the sidebar groups them, with a search over
 * what each is called here and what other helpdesks call it — the settings home
 * Intercom, Zendesk and Freshdesk all open on.
 *
 * The search runs in the browser over a list the server already filtered to
 * what this agent may open: twenty-odd entries need no index, and filtering as
 * you type is the point. Every word typed must appear somewhere in an entry, so
 * "out of office" finds the out-of-hours replies by their keywords and "sla
 * hours" narrows to the one page that is about both.
 */

export type DirectoryStatus = {
  state: 'ready' | 'todo' | 'optional' | 'info';
  text: string;
};

export type DirectoryEntry = {
  href: string;
  label: string;
  description: string;
  keywords: readonly string[];
  status?: DirectoryStatus;
};

export type DirectorySection = {
  title: string;
  description: string;
  entries: DirectoryEntry[];
};

export function SettingsDirectory({ sections }: { sections: DirectorySection[] }) {
  const [query, setQuery] = useState('');
  const words = fold(query).split(' ').filter(Boolean);

  const shown = sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => matches(words, section, entry)),
    }))
    .filter((section) => section.entries.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <SearchInput
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search settings — try “macros”, “office hours” or “WhatsApp”"
        aria-label="Search settings"
        className="max-w-md"
      />

      {shown.length === 0 ? (
        <p className="text-sm text-(--color-text-secondary)">
          No setting matches “{query.trim()}”.
        </p>
      ) : null}

      {shown.map((section) => (
        <section key={section.title} aria-labelledby={sectionId(section.title)}>
          <h2 id={sectionId(section.title)} className="text-base font-semibold">
            {section.title}
          </h2>
          <p className="mb-2 text-xs text-(--color-text-secondary)">{section.description}</p>

          <ul className="grid gap-2 sm:grid-cols-2">
            {section.entries.map((entry) => (
              <li key={entry.href}>
                <Link
                  href={entry.href}
                  className="flex h-full items-start gap-3 rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) p-(--density-card-pad) transition-colors hover:bg-(--color-background-hover)"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{entry.label}</span>
                    <span className="block text-xs text-(--color-text-secondary)">
                      {entry.description}
                    </span>
                    {entry.status ? (
                      <span
                        className={`mt-1 block text-xs ${
                          entry.status.state === 'todo'
                            ? 'text-(--color-feedback-warning-fg)'
                            : 'text-(--color-text-secondary)'
                        }`}
                      >
                        {entry.status.text}
                      </span>
                    ) : null}
                  </span>
                  <StatusBadge status={entry.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status?: DirectoryStatus }) {
  if (status?.state === 'ready') return <Badge tone="success">Ready</Badge>;
  if (status?.state === 'todo') return <Badge tone="warning">Needs setting up</Badge>;
  if (status?.state === 'optional') return <Badge tone="neutral">Optional</Badge>;
  return null;
}

function matches(words: string[], section: DirectorySection, entry: DirectoryEntry): boolean {
  if (words.length === 0) return true;
  const haystack = fold(
    [section.title, entry.label, entry.description, ...entry.keywords].join(' '),
  );
  return words.every((word) => haystack.includes(word));
}

/** Lower case, and punctuation as spaces, so "auto-reply" finds "auto reply". */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function sectionId(title: string): string {
  return `settings-${fold(title).replaceAll(' ', '-')}`;
}
