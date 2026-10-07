'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { ErrorText, Select, Textarea } from '@/components/ui';
import type { CannedResponseOption } from '@/lib/tickets/lookups';
import {
  availableLocales,
  CANNED_LOCALES,
  insertCanned,
  resolveLocale,
  type CannedLocale,
} from '@/lib/tickets/canned';
import { sendReply } from '../../reply-actions';
import { KnowledgePanel } from './knowledge';
import type { KnowledgeContext } from './types';
import { INITIAL, useRefreshOnSuccess } from './form-state';
import { SubmitButton } from '@/components/submit-button';

/**
 * The language toggle's two buttons, each written in its own script.
 *
 * "العربية" is what an Arabic reply looks like, which is the thing the agent is
 * choosing; "AR" beside "EN" is two Latin abbreviations that have to be decoded
 * first.
 */
const LOCALE_LABELS: Record<CannedLocale, string> = { ar: 'العربية', en: 'English' };

/**
 * The same two languages, named in English for the middle of a sentence.
 *
 * A dropdown option is one bidirectional run — "Delivery delay apology —
 * العربية only" puts an RTL span inside an LTR line and the browser reorders
 * the dash and the word "only" around it. The console is English throughout, so
 * the option says "Arabic only" and the button an agent presses stays native.
 */
const LOCALE_NAMES: Record<CannedLocale, string> = { ar: 'Arabic', en: 'English' };

/** The two bodies of a response, in the shape `lib/tickets/canned` reads. */
function bodiesOf(response: CannedResponseOption) {
  return { ar: response.bodyTextAr, en: response.bodyTextEn };
}

export function ReplyForm({
  conversationId,
  isCommentThread = false,
  canned,
  customerLocale,
  knowledge,
  onSent,
}: {
  conversationId: string;
  isCommentThread?: boolean;
  canned: CannedResponseOption[];
  customerLocale: CannedLocale;
  knowledge: KnowledgeContext | null;
  onSent?: () => void;
}) {
  const [state, action] = useActionState(sendReply, INITIAL);
  const [privately, setPrivately] = useState(false);
  useRefreshOnSuccess(state, onSent);

  /*
    Which language the next canned response goes in.

    Above the `key={state.nonce}` boundary deliberately, beside `privately`, and
    for the reason `docs/PROJECT-STATE.md` §6.58 gives: what may survive a send
    here is a *visible control*, never a hidden field. The toggle is on screen showing which
    language the next insertion will use, so an agent can see what carried over
    — and it should carry over. Somebody who has decided to answer an Arabic
    ticket in English is answering the whole thread in English, and a toggle
    that snapped back to the customer's script on every send would undo that
    decision between the greeting and the sign-off.
  */
  const [cannedLocale, setCannedLocale] = useState<CannedLocale>(customerLocale);

  return (
    <form key={state.nonce ?? 0} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input
        type="hidden"
        name="metaSendKind"
        value={privately ? 'private_reply' : 'comment_reply'}
      />

      <ReplyBody
        isCommentThread={isCommentThread}
        privately={privately}
        canned={canned}
        locale={cannedLocale}
        onLocaleChange={setCannedLocale}
        knowledge={knowledge}
      />

      {isCommentThread ? (
        <label className="flex items-start gap-2 rounded-md border border-[var(--border)] p-2 text-xs">
          <input
            type="checkbox"
            checked={privately}
            onChange={(event) => setPrivately(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Reply privately instead</span>
            <span className="block opacity-60">
              Moves the conversation into the direct message inbox. Meta allows this once per
              comment, so it cannot be undone or repeated.
            </span>
          </span>
        </label>
      ) : null}

      <ErrorText>{state.error}</ErrorText>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs opacity-70">
          <input type="checkbox" name="resolveAfter" />
          Resolve after sending
        </label>
        <SubmitButton className="ml-auto" idle="Send reply" busy="Sending…" />
      </div>
    </form>
  );
}

/**
 * The reply box, and the two controls that write into it.
 *
 * A component of its own so that the `key` on the form resets what it
 * remembers. React state lives with the component that declares it, and
 * `usedId` declared in `ReplyForm` outlived the remount that clears the
 * textarea: the reply after one that used a canned response posted the same
 * `cannedResponseId` again, and the server incremented `usage_count` for
 * a response that reply never contained — once more for every reply the agent
 * sent before leaving the ticket. The column exists to rank what the team
 * reaches for, so an over-count that compounds with traffic is worse than no
 * column.
 *
 * `privately` stays in the parent deliberately: it is the send *mode*, and the
 * server re-derives it from the conversation anyway (`metaSendKind` is forced
 * to `dm` off a comment thread), so a stale tick cannot change where a message
 * goes.
 */
function ReplyBody({
  isCommentThread,
  privately,
  canned,
  locale,
  onLocaleChange,
  knowledge,
}: {
  isCommentThread: boolean;
  privately: boolean;
  canned: CannedResponseOption[];
  /** The language the picker inserts, owned by the form above — see there. */
  locale: CannedLocale;
  onLocaleChange: (locale: CannedLocale) => void;
  knowledge: KnowledgeContext | null;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /*
    Which canned response went into this reply, and in which language, for
    `usage_count` and its per-language split.

    Counted on send rather than on insert, because the column exists to rank
    which responses are worth keeping and "reached for and then abandoned" is
    not a use. It is still an over-count in one direction: an agent who inserts
    one and then rewrites every word of it is recorded as having used it. The
    alternative is diffing the sent body against the stored one and picking a
    similarity threshold, which is a number nobody can defend. An empty box is
    the one comparison that needs no threshold — see `forget` below.

    Last one wins, language included. Inserting two into one reply is real — a
    greeting and a closing — but the column counts replies, not fragments, and
    attributing the reply to both would make the totals add up to more than the
    replies sent.

    The language is the one `resolveLocale` actually inserted, not the toggle.
    The toggle's state lives in `ReplyForm` above the key and posts no field,
    so it survives a send — and it can be flipped after the pick, or name a
    language the response was never written in.
  */
  const [used, setUsed] = useState<{ id: string; locale: CannedLocale } | null>(null);

  /*
    An empty box carries no canned response, whatever was picked into it
    earlier. Two things empty it without a send: the agent clearing it to write
    their own — the "never mind" this column is meant not to score — and React,
    which resets the form after a *refused* send (`docs/PROJECT-STATE.md`
    §6.80). The second is why this exists. The textarea came back empty while
    this state, and the hidden fields mirroring it, kept the earlier pick, so
    the reply the agent then typed from nothing was counted as that response —
    the §6.58 over-count again, by a different door. A refusal after an earlier
    success remounts this component instead, which clears it the same way.

    Forgetting is final. An agent who empties the box and then undoes it, or
    cuts the whole text and pastes it back, sends the response uncounted. That
    under-counts, which is the cheaper direction for a ranking column, and
    restoring the pick would mean tracking which inputs are undos. Replacing
    the whole text in one gesture without passing through empty still counts,
    as rewording does.
  */
  const forget = useCallback(() => setUsed(null), []);

  useEffect(() => {
    const form = bodyRef.current?.form;
    if (!form) return;
    form.addEventListener('reset', forget);
    return () => form.removeEventListener('reset', forget);
  }, [forget]);

  /*
    Two things insert into this box now — a canned response and an article link
    — and they want identical caret handling and different bookkeeping. Taking
    text rather than a row keeps `insertCanned`'s off-by-one in one place and
    leaves `usage_count`, which is about canned responses specifically, to the
    one caller that owes it.
  */
  const insertText = useCallback((snippet: string) => {
    const box = bodyRef.current;
    if (!box) return;

    const { text, caret } = insertCanned(box.value, snippet, box.selectionStart, box.selectionEnd);

    // Written straight to the node, because the textarea is uncontrolled — the
    // form is keyed on the send nonce so the browser keeps the agent's draft
    // through a tab switch, and making it controlled to support this would give
    // that up for every reply in order to serve the ones that use a snippet.
    box.value = text;
    box.focus();
    box.setSelectionRange(caret, caret);
  }, []);

  const insertCannedResponse = useCallback(
    (response: CannedResponseOption, locale: CannedLocale) => {
      const bodies = bodiesOf(response);

      // The language it was actually written in, which is the one the option
      // said it would insert. Null means a response with neither body — nothing
      // `saveCannedResponse` can create, and nothing to put in the box.
      const chosen = resolveLocale(bodies, locale);
      if (!chosen) return;

      insertText(bodies[chosen]);
      setUsed({ id: response.id, locale: chosen });
    },
    [insertText],
  );

  return (
    <>
      <input type="hidden" name="cannedResponseId" value={used?.id ?? ''} />
      <input type="hidden" name="cannedLocale" value={used?.locale ?? ''} />

      <Textarea
        ref={bodyRef}
        name="body"
        rows={4}
        placeholder={
          isCommentThread
            ? privately
              ? 'Send this privately to the commenter — one chance per comment.'
              : 'Reply under the comment, where everyone can see it…'
            : 'Write a reply to the customer…'
        }
        required
        onInput={(event) => {
          if (!event.currentTarget.value.trim()) forget();
        }}
      />

      <CannedPicker
        responses={canned}
        locale={locale}
        onLocaleChange={onLocaleChange}
        onPick={insertCannedResponse}
      />

      {knowledge ? (
        <KnowledgePanel
          suggestions={knowledge.suggestions}
          locale={knowledge.locale}
          onInsert={insertText}
        />
      ) : null}
    </>
  );
}

/**
 * The canned response picker, and the language it inserts.
 *
 * A `<select>` rather than a search palette. This codebase has no modals, the
 * list is a handful of rows per team rather than hundreds, and a control that
 * inserts on change is the same gesture every other field in the console uses.
 * If the list ever grows past what a dropdown can carry, the folder grouping
 * below is already the shape a search would filter.
 *
 * It sits under the textarea rather than above it because the box is what the
 * agent came here to type in — a picker above it pushes the thing they want
 * down the screen, on a phone especially.
 *
 * Renders nothing at all when there are none, rather than an empty dropdown
 * that reads as broken.
 *
 * **The language is a control beside the list, not a second list.** Two entries
 * per response would double a dropdown an agent scans by eye, and it would put
 * the choice they rarely change — the customer is writing in one language, and
 * they will use that one for every response in the reply — in front of them on
 * every pick. So it is one toggle, set from the script of what the customer
 * actually wrote, and an agent answering an English mail in Arabic flips it
 * once. A response that has only the other language says so on its own option
 * rather than disappearing from the list; see `resolveLocale`.
 */
function CannedPicker({
  responses,
  locale,
  onLocaleChange,
  onPick,
}: {
  responses: CannedResponseOption[];
  locale: CannedLocale;
  onLocaleChange: (locale: CannedLocale) => void;
  onPick: (response: CannedResponseOption, locale: CannedLocale) => void;
}) {
  if (responses.length === 0) return null;

  // Grouped by folder, with the unfiled ones first — an agent scanning for
  // "Refund approved" reads the folder names as headings rather than as a flat
  // list that happens to be sorted.
  const folders = [...new Set(responses.map((r) => r.folder ?? ''))];

  const label = (response: CannedResponseOption) => {
    const available = availableLocales(bodiesOf(response));

    // Only worth saying when the response cannot answer the language the
    // toggle is set to. A response carrying both is the ordinary case, and
    // marking every line would bury the exceptions in the noise.
    if (available.length === 1 && available[0] !== locale) {
      return `${response.title} — ${LOCALE_NAMES[available[0]!]} only`;
    }

    return response.title;
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">Canned reply</span>
        <Select
          // Always reads "Insert…": it is an action, not a stored value, and a
          // select that kept the last pick would claim the reply still contains
          // something the agent may have since deleted.
          value=""
          onChange={(event) => {
            const picked = responses.find((r) => r.id === event.target.value);
            if (picked) onPick(picked, locale);
          }}
          className="min-w-0 flex-1"
        >
          <option value="">Insert…</option>
          {folders.map((folder) =>
            folder ? (
              <optgroup key={folder} label={folder}>
                {responses
                  .filter((r) => (r.folder ?? '') === folder)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {label(r)}
                    </option>
                  ))}
              </optgroup>
            ) : (
              responses
                .filter((r) => (r.folder ?? '') === '')
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {label(r)}
                  </option>
                ))
            ),
          )}
        </Select>
      </label>

      <div
        role="group"
        aria-label="Canned reply language"
        className="flex shrink-0 overflow-hidden rounded-md border border-[var(--border)]"
      >
        {CANNED_LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            // The pressed state, not a radio: this changes what the next pick
            // inserts and nothing about the reply being submitted, so it must
            // not travel with the form.
            aria-pressed={option === locale}
            onClick={() => onLocaleChange(option)}
            className={
              option === locale
                ? 'bg-brand-600 px-2 py-1 font-medium text-white'
                : 'px-2 py-1 hover:bg-[var(--muted)]'
            }
          >
            {LOCALE_LABELS[option]}
          </button>
        ))}
      </div>
    </div>
  );
}
