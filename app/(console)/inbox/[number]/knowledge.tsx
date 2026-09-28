'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { BookIcon, ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { InfoTip } from '@/components/tooltip';
import { Badge, Input } from '@/components/ui';
import type { AgentArticleHit } from '@/lib/kb/agent-search';

/**
 * Reading the knowledge base without leaving the ticket.
 *
 * Under the textarea, beside the canned picker, for the reason the canned
 * picker gives for being there: the box is what the agent came here to type in,
 * and a panel above it pushes that down the screen on a phone. The right-hand
 * sidebar is where a helpdesk usually puts this, and it is the wrong place
 * here — it is `hidden … xl:block`, so on the laptop and the phone the console
 * is actually read on, the panel would not exist.
 *
 * Not a command palette and not a dialog. `composer.tsx` explains why the
 * canned responses are a `<select>` and says what should replace it when the
 * list outgrows one: "the folder grouping below is already the shape a search
 * would filter". 112 articles is that point. This is that search, expanded in
 * place, with the same no-modal rule the rest of the console keeps.
 */

/**
 * Long enough that a word typed at speed is one request, short enough that the
 * list feels attached to the keyboard.
 */
const DEBOUNCE_MS = 250;

type Locale = 'ar' | 'en';

/** A search result set, tagged with the locale and query it answers. */
type Answer = { key: string; hits: AgentArticleHit[]; failed: boolean };

export function KnowledgePanel({
  suggestions,
  locale: detected,
  onInsert,
}: {
  /** Seeded from the ticket on the server, so they are there on first paint. */
  suggestions: AgentArticleHit[];
  /** The language the customer is writing in, as far as their script says. */
  locale: Locale;
  onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<Locale>(detected);
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);

  const panelId = useId();
  const trimmed = query.trim();
  const searchable = trimmed.length >= 2;

  /*
    An answer carries the question it answers, and only a matching one counts.

    The obvious shape — a `results` array plus a `searching` flag, cleared
    whenever the query changes — needs the effect to write state on the way in
    as well as on the way out, and then every render the SSE stream provokes has
    to be checked for whether it re-clears something. Keying the answer instead
    makes "we have not searched for this yet" and "we searched and found
    nothing" different values rather than the same empty array, and both of them
    fall out of the render with no synchronisation at all.
  */
  const key = `${locale}\u0000${trimmed}`;
  const current = answer?.key === key ? answer : null;

  /*
    One in-flight request at a time, cancelled rather than raced.

    Without the abort, four keystrokes leave four responses arriving in whatever
    order the network settles them in, and the list ends up showing the answer
    to a prefix of what the agent typed. The controller lives in a ref because
    an SSE refresh re-renders this subtree several times a minute, and one held
    in state would be replaced by a controller with nothing to cancel.
  */
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open || !searchable || current) return;

    const search = async () => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      try {
        const response = await fetch(
          `/api/knowledge?q=${encodeURIComponent(trimmed)}&locale=${locale}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(String(response.status));

        const body: { articles: AgentArticleHit[] } = await response.json();
        setAnswer({ key, hits: body.articles, failed: false });
      } catch (error) {
        // An abort is this component cancelling itself, not a failure to
        // report — saying "search failed" as the agent types the next letter
        // would flash an error on every keystroke. A real failure is recorded
        // against the query that caused it, so it clears as soon as they edit
        // it rather than retrying in a loop.
        if ((error as Error).name === 'AbortError') return;
        setAnswer({ key, hits: [], failed: true });
      }
    };

    // `void` because the promise cannot reject: every failure is caught above
    // and becomes state.
    const timer = setTimeout(() => void search(), DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, searchable, current, key, trimmed, locale]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const shown = searchable ? (current?.hits ?? []) : suggestions;
  const showingSuggestions = !searchable && suggestions.length > 0;
  const searching = searchable && !current;

  return (
    <div className="rounded-md border border-[var(--border)]">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-xs text-[var(--muted-foreground)]"
      >
        <BookIcon size={14} className="shrink-0" />
        <span className="font-medium">Knowledge</span>
        {!open && suggestions.length > 0 ? (
          <Badge tone="brand">{suggestions.length} suggested</Badge>
        ) : null}
        <span className="ms-auto">
          {open ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
        </span>
      </button>

      {/*
        Hidden rather than unmounted, so a search survives the agent collapsing
        the panel to re-read the ticket — the same reason the composer keeps its
        own panel mounted on mobile.
      */}
      <div id={panelId} hidden={!open} className="border-t border-[var(--border)] p-2">
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search articles…"
            aria-label="Search knowledge base articles"
            className="min-w-0 flex-1"
          />
          <LocaleToggle value={locale} onChange={setLocale} />
        </div>

        {showingSuggestions ? (
          // Labelled rather than presented as answers. Ranks across the whole
          // result set span a factor of two, so the top hit is a reasonable
          // guess and not a verdict, and the search box is right above it.
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">Suggested for this ticket</p>
        ) : null}

        <div className="app-scroll mt-1 max-h-56 overflow-y-auto">
          {shown.map((hit) => (
            <Hit key={hit.id} hit={hit} onInsert={onInsert} />
          ))}

          {shown.length === 0 ? (
            <p className="px-1 py-3 text-xs text-[var(--muted-foreground)]">
              {current?.failed
                ? 'Search is unavailable right now.'
                : searching
                  ? 'Searching…'
                  : searchable
                    ? `Nothing in ${locale === 'ar' ? 'Arabic' : 'English'} matches “${trimmed}”.`
                    : 'Type to search the knowledge base.'}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Which language's articles to search.
 *
 * The ticket's own language is a guess off the script of the customer's last
 * message, and it is wrong often enough to need an override — a merchant who
 * writes in English about an Arabic-only article is an ordinary Tuesday. Two
 * buttons rather than a `<select>` because there are exactly two and the whole
 * point is that switching costs one tap.
 */
function LocaleToggle({ value, onChange }: { value: Locale; onChange: (next: Locale) => void }) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-[var(--border)]">
      {(['ar', 'en'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`px-2 py-1.5 text-xs sm:py-1 ${
            value === option
              ? 'bg-brand-500/15 font-medium text-brand-700'
              : 'text-[var(--muted-foreground)]'
          }`}
        >
          {option === 'ar' ? 'العربية' : 'English'}
        </button>
      ))}
    </div>
  );
}

function Hit({ hit, onInsert }: { hit: AgentArticleHit; onInsert: (text: string) => void }) {
  const [reading, setReading] = useState(false);
  const bodyId = useId();

  const insert = useCallback(() => {
    // Title and URL on separate lines. Every channel we send on carries plain
    // text, so there is no anchor to hang a title on — and on its own line the
    // Latin URL cannot be reordered by the bidi algorithm when it lands in the
    // middle of an Arabic paragraph.
    onInsert(`${hit.title}\n${hit.url}`);
  }, [hit, onInsert]);

  return (
    <div className="border-b border-[var(--border)] px-1 py-1.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setReading((was) => !was)}
          aria-expanded={reading}
          aria-controls={bodyId}
          className="min-w-0 flex-1 text-start text-xs"
        >
          {/*
            `dir="auto"` rather than `direction()` from lib/kb/locale: importing
            that module into a client component drags its whole bilingual string
            dictionary onto the busiest route in the console. The first strong
            character answers the same question for free.
          */}
          <span dir="auto" className="block truncate font-medium">
            {hit.title}
          </span>
          <span dir="auto" className="block truncate text-[var(--muted-foreground)]">
            {hit.categoryName} · {hit.folderName}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <LinkControl hit={hit} onInsert={insert} />
        </div>
      </div>

      {reading ? <Body id={bodyId} hit={hit} /> : null}
    </div>
  );
}

/**
 * The insert control, and what stops it.
 *
 * An agent may read anything published; they may only send a link the recipient
 * can open. Production has four Arabic articles in `agents_only` folders that
 * carry `visibility = 'public'` on the article row itself, so this decision
 * cannot be made from the article alone and is made in SQL over both levels.
 * See `effectiveVisibility` in `lib/kb/agent-search.ts`.
 */
function LinkControl({ hit, onInsert }: { hit: AgentArticleHit; onInsert: () => void }) {
  if (hit.link === 'blocked') {
    return (
      <>
        <Badge tone="warning">
          {hit.visibility === 'agents_only' ? 'Internal' : 'No audience'}
        </Badge>
        <InfoTip label="why this cannot be linked">
          {hit.visibility === 'agents_only'
            ? 'This article is in an internal folder. It is not on the public help centre, so a link to it would not open for a customer.'
            : 'This article is limited to selected companies and no company has been given access, so nobody can open it yet.'}
        </InfoTip>
      </>
    );
  }

  return (
    <>
      {hit.link === 'sign_in' ? (
        <InfoTip label="this article's audience">
          Only opens for a customer who is signed in to the portal. Anyone else gets the sign-in
          page instead of the article.
        </InfoTip>
      ) : null}
      <button
        type="button"
        onClick={onInsert}
        className="rounded border border-[var(--border)] px-1.5 py-1 text-xs whitespace-nowrap hover:bg-[var(--muted)]"
      >
        Insert link
      </button>
    </>
  );
}

function Body({ id, hit }: { id: string; hit: AgentArticleHit }) {
  return (
    <div id={id} className="mt-1.5 rounded bg-[var(--muted)] p-2 text-xs">
      {hit.bodyText ? (
        <p dir="auto" className="whitespace-pre-wrap">
          {hit.bodyText}
          {hit.bodyTruncated ? '…' : ''}
        </p>
      ) : (
        // Two of the imported articles are images and nothing else, so their
        // body text is empty. Saying so beats an empty grey box that reads as
        // a bug.
        <p className="text-[var(--muted-foreground)]">
          This article is images only — open it on the help centre to see it.
        </p>
      )}

      <a
        href={hit.url}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-block underline opacity-70"
      >
        {hit.bodyTruncated ? 'Read the rest on the help centre' : 'Open on the help centre'}
      </a>
    </div>
  );
}
