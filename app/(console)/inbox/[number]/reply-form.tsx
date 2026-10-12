'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { GlobeIcon, SendIcon, XIcon } from '@/components/icons';
import { Button, ErrorText, Select, Textarea } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { suggestionKey } from '@/lib/canned-suggest/keyboard';
import type { CannedResponseOption } from '@/lib/tickets/lookups';
import {
  availableLocales,
  insertCanned,
  resolveLocale,
  type CannedLocale,
} from '@/lib/tickets/canned';
import { sendReply } from '../../reply-actions';
import { KnowledgeButton, KnowledgePanel } from './knowledge';
import { LocaleToggle } from './locale-toggle';
import type { KnowledgeContext } from './types';
import { INITIAL, LOST_SEND } from './form-state';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';
import { useCannedSuggestion } from './use-canned-suggestion';

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
  suggest = false,
  anchorMessageId = null,
  onSent,
}: {
  conversationId: string;
  isCommentThread?: boolean;
  canned: CannedResponseOption[];
  customerLocale: CannedLocale;
  knowledge: KnowledgeContext | null;
  /** Whether to ask Jev for a canned response when the box takes focus. */
  suggest?: boolean;
  /** The newest reply on the ticket — what a suggestion answers. See `CannedSuggestion`. */
  anchorMessageId?: string | null;
  onSent?: () => void;
}) {
  const { state, key, form } = useActionForm(sendReply, INITIAL, {
    lost: LOST_SEND,
    onSuccess: onSent,
  });
  const [privately, setPrivately] = useState(false);
  // Said on the button as well as in the notice above the tabs: the press is
  // the moment the agent commits, and "Send" under a public comment does not
  // say that everyone who can see the post will read it.
  const inPublic = isCommentThread && !privately;

  /*
    Which language the next canned response goes in.

    Above the form's `key` boundary deliberately, beside `privately`, and
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
    <form key={key} {...form} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      <input
        type="hidden"
        name="metaSendKind"
        value={privately ? 'private_reply' : 'comment_reply'}
      />

      <ReplyBody
        conversationId={conversationId}
        isCommentThread={isCommentThread}
        privately={privately}
        canned={canned}
        locale={cannedLocale}
        onLocaleChange={setCannedLocale}
        knowledge={knowledge}
        suggest={suggest}
        anchorMessageId={anchorMessageId}
      />

      {isCommentThread ? (
        <label className="flex items-start gap-2 rounded-md border border-(--color-border-subtle) p-2 text-xs">
          <input
            type="checkbox"
            checked={privately}
            onChange={(event) => setPrivately(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-blu-500"
          />
          <span>
            <span className="font-medium">Reply privately instead</span>
            <span className="block text-(--color-text-secondary)">
              Moves the conversation into the direct message inbox. Meta allows this once per
              comment, so it cannot be undone or repeated.
            </span>
          </span>
        </label>
      ) : null}

      <ErrorText>{state.error}</ErrorText>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-(--color-text-secondary)">
          <input type="checkbox" name="resolveAfter" className="size-4 accent-blu-500" />
          Resolve after sending
        </label>
        <SubmitButton
          className="ms-auto"
          icon={inPublic ? <GlobeIcon size={15} /> : <SendIcon size={15} />}
          idle={inPublic ? 'Post publicly' : 'Send reply'}
          busy="Sending…"
        />
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
  conversationId,
  isCommentThread,
  privately,
  canned,
  locale,
  onLocaleChange,
  knowledge,
  suggest,
  anchorMessageId,
}: {
  conversationId: string;
  isCommentThread: boolean;
  privately: boolean;
  canned: CannedResponseOption[];
  /** The language the picker inserts, owned by the form above — see there. */
  locale: CannedLocale;
  onLocaleChange: (locale: CannedLocale) => void;
  knowledge: KnowledgeContext | null;
  suggest: boolean;
  anchorMessageId: string | null;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Here rather than in the panel, because its button sits in the toolbar row
  // beside the canned picker and the panel opens under that row. Under the
  // form's key like the rest of this component, so a send closes it as it
  // always has.
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const knowledgeId = useId();

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
    Every canned response inserted since the box was last empty, for grading a
    canned suggestion — not for `usage_count`, which stays last-one-wins above.
    A suggestion taken with Tab and then followed by a closing from the list
    went out in the reply, and a grade read off `used` alone would call Jev
    wrong for it. Forgotten with `used`, on the same empty box.
  */
  const [inserted, setInserted] = useState<string[]>([]);

  /*
    An empty box carries no canned response, whatever was picked into it
    earlier: the agent cleared it to write their own, which is the "never mind"
    this column is meant not to score.

    A refused send used to empty it too. React reset the form after one
    (`docs/PROJECT-STATE.md` §6.80), and the textarea came back empty while
    this state, and the hidden fields mirroring it, kept the earlier pick, so
    the reply the agent then typed from nothing was counted as that response —
    the §6.58 over-count again, by a different door. This component listened
    for that `reset` until the form moved onto `useActionForm`, which queues
    none: a refusal now keeps the draft and the pick together, and only a
    success remounts this component, clearing both.

    Forgetting is final. An agent who empties the box and then undoes it, or
    cuts the whole text and pastes it back, sends the response uncounted. That
    under-counts, which is the cheaper direction for a ranking column, and
    restoring the pick would mean tracking which inputs are undos. Replacing
    the whole text in one gesture without passing through empty still counts,
    as rewording does.
  */
  const forget = useCallback(() => {
    setUsed(null);
    setInserted([]);
  }, []);

  /*
    Whether the box is empty — the one condition every part of the suggestion
    turns on. The text lives in the DOM, so this mirrors it: told by `onInput`
    when the agent types, and by `insertText` when a pick or a link goes in.
  */
  const [empty, setEmpty] = useState(true);

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
    // A value set from code fires no `input`, so the box's emptiness — which
    // decides whether a suggestion shows — is told here.
    setEmpty(!text.trim());
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
      setInserted((ids) => (ids.includes(response.id) ? ids : [...ids, response.id]));
    },
    [insertText],
  );

  const suggestion = useCannedSuggestion({
    conversationId,
    suggest,
    anchorMessageId,
    bodyRef,
    inserted,
  });

  // The suggested response as it would go in: in the language the toggle names,
  // or the one it was written in — exactly what Tab will insert.
  const suggested = suggestion.showable
    ? (canned.find((response) => response.id === suggestion.showable?.cannedResponseId) ?? null)
    : null;
  const suggestedLocale = suggested ? resolveLocale(bodiesOf(suggested), locale) : null;
  const ghost = suggested && suggestedLocale ? bodiesOf(suggested)[suggestedLocale] : null;
  const showing = Boolean(ghost && empty);
  const hintId = useId();

  const { markShown } = suggestion;
  useEffect(() => {
    if (showing) markShown();
  }, [showing, markShown]);

  /*
    Since when the suggestion now showing has been in front of the agent in the
    focused box — what Tab's wait in `suggestionKey` is measured from. Started
    again whenever a different suggestion shows, the box empties back into
    showing one, or focus comes back, so a Tab-Tab through the composer always
    lands inside the wait however long the ghost sat there unfocused.
  */
  const seenSince = useRef<number | null>(null);
  const showingId = showing ? (suggestion.showable?.id ?? null) : null;
  useEffect(() => {
    const box = bodyRef.current;
    seenSince.current =
      showingId && box && document.activeElement === box ? performance.now() : null;
  }, [showingId]);

  const acceptSuggestion = () => {
    if (!suggested) return;
    insertCannedResponse(suggested, locale);
    suggestion.accept();
  };

  return (
    <>
      <input type="hidden" name="cannedResponseId" value={used?.id ?? ''} />
      <input type="hidden" name="cannedLocale" value={used?.locale ?? ''} />
      <input type="hidden" name="cannedSuggestionId" value={suggestion.linkId ?? ''} />
      <input type="hidden" name="cannedInsertedIds" value={inserted.join(',')} />

      <Textarea
        ref={bodyRef}
        name="body"
        rows={4}
        dir="auto"
        // The suggestion is the placeholder: grey, gone the moment the agent
        // types, and never sent by accident — the box is still empty and still
        // `required`, so Send refuses it until Tab or Use has put the text in.
        placeholder={
          ghost ??
          (isCommentThread
            ? privately
              ? 'Send this privately to the commenter — one chance per comment.'
              : 'Reply under the comment, where everyone can see it…'
            : 'Write a reply to the customer…')
        }
        required
        aria-describedby={showing ? hintId : undefined}
        onFocus={(event) => {
          seenSince.current = showing ? performance.now() : null;
          if (!event.currentTarget.value.trim()) suggestion.ask();
        }}
        onBlur={() => {
          seenSince.current = null;
        }}
        onKeyDown={(event) => {
          if (!showing) return;
          const since = seenSince.current;
          const action = suggestionKey(
            {
              key: event.key,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            },
            since === null ? 0 : performance.now() - since,
          );
          if (!action) return;
          event.preventDefault();
          if (action === 'accept') acceptSuggestion();
          else suggestion.dismiss();
        }}
        onInput={(event) => {
          const isEmpty = !event.currentTarget.value.trim();
          setEmpty(isEmpty);
          if (isEmpty) forget();
        }}
      />

      {/*
        Always rendered while suggestions are on, so a screen reader is already
        listening to the region when a suggestion arrives in it — a live region
        added together with its content is not announced.

        Use and × are buttons as well as keys because the console is read on
        phones, which have no Tab key.
      */}
      {suggest ? (
        // `relative` because the key hint below can be `sr-only`, which is
        // `position: absolute` — unpositioned, it is placed against the page
        // and lengthens it (PROJECT-STATE §6.81). `empty:-mt-2` because, empty,
        // it is still a flex item of the form's `gap-2` column, and the gap on
        // both sides of a zero-height item pushed the picker down by one gap
        // whenever nothing was suggested.
        <div
          id={hintId}
          aria-live="polite"
          className="relative text-xs text-(--color-text-secondary) empty:-mt-2"
        >
          {showing && suggested ? (
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate">
                Suggested: <span className="font-medium">{suggested.title}</span>
              </span>
              <InfoTip label="the suggested response">
                Picked by TypeSafe&rsquo;s Jev model from your canned responses, after reading the
                last messages on this ticket (never the private notes). Use it as it stands or edit
                it first &mdash; nothing is sent until you press Send.
              </InfoTip>
              {/*
                Said wherever a keyboard can press it: on screen with any fine
                pointer — a laptop zoomed past the breakpoint still has a Tab
                key — and always to a screen reader through aria-describedby.
                Hidden only on screen on a touch-only phone, which has no Tab.
              */}
              <span className="sr-only shrink-0 any-pointer-fine:not-sr-only">
                Tab to use · Esc to dismiss
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={acceptSuggestion}
                className="ms-auto shrink-0"
              >
                Use
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={suggestion.dismiss}
                aria-label="Dismiss the suggested response"
                className="shrink-0 px-1.5!"
              >
                <XIcon size={14} />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Only when either control exists: an empty row is still a flex item
          of the form's column, and would add a second gap under the box. */}
      {canned.length > 0 || knowledge ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <CannedPicker
            responses={canned}
            locale={locale}
            onLocaleChange={onLocaleChange}
            onPick={insertCannedResponse}
          />
          {knowledge ? (
            <KnowledgeButton
              open={knowledgeOpen}
              onToggle={() => setKnowledgeOpen((was) => !was)}
              panelId={knowledgeId}
              suggested={knowledge.suggestions.length}
            />
          ) : null}
        </div>
      ) : null}

      {knowledge ? (
        <KnowledgePanel
          id={knowledgeId}
          open={knowledgeOpen}
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
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs text-(--color-text-secondary)">
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

      <LocaleToggle value={locale} onChange={onLocaleChange} label="Canned reply language" />
    </div>
  );
}
