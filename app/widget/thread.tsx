'use client';

import {
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ChatBubble } from '@/components/chat';
import { DocumentIcon, PaperclipIcon, SendIcon, SmileIcon, XIcon } from '@/components/icons';
import { Button, ErrorText, SuccessText } from '@/components/ui';
import { isPreviewableImage, mediaFamily } from '@/lib/attachments/preview';
import { runPositions } from '@/lib/chat/runs';
import { formatBytes } from '@/lib/format';
import { direction, type Locale } from '@/lib/kb/locale';
import { parseVisitorDetails } from '@/lib/widget/contact';
import {
  admitWidgetFiles,
  MAX_WIDGET_FILE_BYTES,
  MAX_WIDGET_FILES,
  MAX_WIDGET_MESSAGE_CHARS,
  WIDGET_ACCEPT,
  type WidgetFileRefusal,
} from '@/lib/widget/files';
import type { WidgetCopy } from './copy';
import { EmojiPicker, type PickedWith } from './emoji-picker';
import { WIDGET_COMPOSER_BOX, WIDGET_FIELD } from './field';
import { WidgetFiles } from './message-files';
import { SurveyCard, type SurveyResult } from './survey-card';
import type { ArticleLink, Message } from '@/lib/widget/types';

/**
 * The conversation itself.
 *
 * Reached by choosing it, from the home screen or from the bottom of an article
 * that did not answer the question — so by the time a visitor is here they have
 * decided to talk to somebody, and everything on screen is about getting their
 * message sent.
 */
export function WidgetThread({
  locale,
  copy,
  messages,
  online,
  active,
  detailsSaved,
  prefill,
  onSend,
  onSaveDetails,
  onOpenArticle,
  onAnswerSurvey,
}: {
  locale: Locale;
  copy: WidgetCopy;
  messages: Message[];
  online: boolean;
  /** Whether this view is the one showing. It stays mounted while hidden. */
  active: boolean;
  detailsSaved: boolean;
  /** A draft the host page asked us to start the visitor off with, or null. */
  prefill: { text: string; seq: number } | null;
  onSend: (body: string, files: File[], details: OfflineDetails | null) => Promise<SendOutcome>;
  onSaveDetails: (details: OfflineDetails) => Promise<boolean>;
  onOpenArticle: (article: ArticleLink) => void;
  onAnswerSurvey: (
    surveyId: string,
    rating: number,
    comment: string | null,
  ) => Promise<SurveyResult>;
}) {
  const [draft, setDraft] = useState('');
  /** The files chosen for the next message, in the order they were picked. */
  const [files, setFiles] = useState<File[]>([]);
  /** What went wrong with the last file chosen or the last send, until the next try. */
  const [notice, setNotice] = useState<SendRefusal | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** Whether the panel opened from the keyboard, and so takes focus. */
  const [emojiTakesFocus, setEmojiTakesFocus] = useState(false);
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<ArticleLink[]>([]);
  const [details, setDetails] = useState<OfflineDetails>({ name: '', email: '', phone: '' });
  const [detailsError, setDetailsError] = useState<'missing' | 'invalid' | null>(null);
  // Points the email and phone boxes at the line saying what is wrong with
  // them, so the invalid state is read out with its reason.
  const detailsHintId = useId();
  const [savingDetails, setSavingDetails] = useState(false);

  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachButton = useRef<HTMLButtonElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  /** The last prefill actually put in the box, so a repaint does not redo it. */
  const applied = useRef(0);
  /** A caret waiting for the value it is meant to sit at the end of. */
  const caretPending = useRef(false);
  /** A caret waiting to sit after an emoji just put in the focused box. */
  const caretAt = useRef<number | null>(null);
  /**
   * Words put in the box from code with the caret at their end — a draft from
   * the host page, or a failed send's put back — whose end the box scrolls to
   * once it has measured them (the effect that sizes it).
   */
  const revealEnd = useRef(false);
  /**
   * Where the next emoji goes while the box is not focused — picked from the
   * keyboard, or tapped on a phone. Setting a controlled value moves an
   * unfocused field's own selection to its end, so the field cannot remember
   * this itself; and it is put back when the box is focused again.
   */
  const insertAt = useRef<number | null>(null);
  /** The kind of pointer that last pressed the emoji button. */
  const lastPointer = useRef<'mouse' | 'touch'>('mouse');
  /** A press on the box is placing its own caret, which `insertAt` must not move. */
  const pressingBox = useRef(false);
  /** What last pressed the box, read when its click arrives. */
  const boxPointer = useRef<string | null>(null);

  /*
   * A draft handed over by the host page.
   *
   * Never over something the visitor has already started writing. The tracking
   * page's button can be pressed twice, and a second press that wiped a
   * half-written sentence would cost far more than the two lines it was trying
   * to save — so a non-empty box keeps what is in it and only the caret moves.
   *
   * Applying it is one thing and putting the caret after it is another, because
   * the field still holds the old value when this runs: `setDraft` has not been
   * rendered yet. The effect below waits for the value and then places the
   * caret, which is also what makes the case above right — the caret lands at
   * the end of whatever the visitor kept.
   */
  useEffect(() => {
    if (!prefill || prefill.seq === applied.current) return;

    applied.current = prefill.seq;
    caretPending.current = true;
    revealEnd.current = true;
    setDraft((current) => (current.trim() ? current : prefill.text));
  }, [prefill]);

  useEffect(() => {
    const field = composer.current;
    if (caretAt.current !== null) {
      const at = caretAt.current;
      caretAt.current = null;
      // Only on the focused box: some engines focus a field to select in it,
      // which on a phone brings the keyboard back up over the panel.
      if (field && document.activeElement === field) field.setSelectionRange(at, at);
    }

    if (!caretPending.current) return;
    caretPending.current = false;
    if (!field) return;

    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [draft]);

  /*
   * The composer grows with what is in it, up to a point.
   *
   * One fixed row is right for an empty box and wrong the moment something is
   * already in one: a prefilled draft shows its first line and hides the line
   * the caret is on, so the visitor cannot see where they are about to type —
   * which reads as the button having half worked.
   *
   * Measured rather than counted off the newlines. The panel is 380px wide and
   * `Tracking number: 1755021358719` wraps in it, so the lines that decide the
   * height are the ones the browser drew, not the ones somebody typed.
   *
   * Nothing is measured while the thread is hidden: `scrollHeight` is 0 inside
   * a `display:none` subtree, so a visitor opening an article would come back
   * to a box collapsed to nothing. `active` in the dependencies is what
   * re-measures it on the way back.
   *
   * Past the cap the box scrolls, and words put in from code are scrolled to
   * their end (`revealEnd`), where the caret is. Chrome scrolls a textarea to
   * the caret when somebody types, never when code sets the value or the
   * selection, so a prefilled draft longer than six lines, or a long message a
   * failed send put back, showed its first six lines and hid the one the caret
   * was on — the failure above, at the cap. Here rather than where the caret
   * is placed, because only here is the box its final height; and a send that
   * fails while the thread is hidden keeps the flag until it is measured again.
   *
   * Only once the box holds the words. A prefill that opens the thread is set
   * in the render after it mounts, and a pass before it — React's second run of
   * every effect in development, or a measure with nothing in the box yet —
   * would otherwise spend the flag on an empty box.
   */
  useLayoutEffect(() => {
    const field = composer.current;
    if (!field || !active) return;

    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, MAX_COMPOSER_PX)}px`;
    if (revealEnd.current && field.value) {
      revealEnd.current = false;
      field.scrollTop = field.scrollHeight;
    }
  }, [draft, active]);

  /*
   * Out of hours, ask before the message rather than after it.
   *
   * The old prompt appeared once a message existed, which is the wrong order: a
   * visitor who typed at 2am and closed the tab had already gone by the time we
   * asked how to reach them. Asking first costs a field they can ignore and
   * turns the message into something answerable.
   *
   * It stays up until the details are actually stored, not until they are
   * typed — the write is a second request that can fail on its own, and silently
   * dropping a phone number the visitor believes they left is the one failure
   * this whole form exists to prevent.
   */
  const askForDetails = !online && !detailsSaved;

  /*
   * Which way they get sent. Before the first message there is no conversation
   * for `/api/widget/contact` to hang its timeline event on, so the details ride
   * along with the message; afterwards they need a button of their own, or a
   * failed write could only be retried by writing another message.
   */
  const started = messages.some((message) => message.from === 'visitor');

  /*
   * Judged by the same function the route judges them with.
   *
   * `parseVisitorDetails` is pure, so importing it here rather than re-spelling
   * "non-empty" closes the gap where a client check passes, the server's own
   * rejects, and the visitor sees nothing at all happen — believing they left a
   * number that was never stored.
   */
  const supplied = Boolean(details.email.trim() || details.phone.trim());
  const usable = parseVisitorDetails(details) !== null;

  async function saveDetails() {
    if (!usable) {
      setDetailsError(supplied ? 'invalid' : 'missing');
      return;
    }

    setDetailsError(null);
    setSavingDetails(true);
    const ok = await onSaveDetails(details);
    setSavingDetails(false);
    // The server is the authority even though it runs the same check; a 429 or a
    // dropped connection lands here too, and silence would read as success.
    if (!ok) setDetailsError('invalid');
  }

  // --- Article suggestions, mid-typing ------------------------------------

  useEffect(() => {
    const query = draft.trim();
    if (query.length < 6) return;

    const timer = setTimeout(() => {
      void fetch(`/api/widget/search?q=${encodeURIComponent(query)}&locale=${locale}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => setSuggestions(((data?.articles as ArticleLink[]) ?? []).slice(0, 3)))
        .catch(() => setSuggestions([]));
    }, 400);

    return () => clearTimeout(timer);
  }, [draft, locale]);

  // Derived, so a half-typed word hides the previous suggestions immediately
  // instead of leaving stale ones on screen until the next fetch settles.
  const visibleSuggestions = draft.trim().length < 6 ? [] : suggestions;

  /*
   * Also keyed on `active`, because the thread stays mounted while hidden.
   * `scrollIntoView` does nothing inside a `display:none` subtree, so a reply
   * that arrives while the visitor is reading an article would scroll nowhere,
   * and on Back nothing would re-run — leaving them at their old position with
   * the reply they were waiting for below the fold.
   */
  useEffect(() => {
    if (!active) return;
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, active]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const body = draft.trim();
    const attached = files;
    if ((!body && attached.length === 0) || sending) return;

    /*
     * The details are asked for, never required.
     *
     * Refusing to send without them looks like insisting on a contact detail and
     * is actually worse than that: `online` is false whenever no business hours
     * are configured at all — `groupHours` returns null and the widget treats
     * that as closed — so a deployment that has never set a schedule would
     * refuse every first message anybody ever typed. Losing what they wrote is
     * the bigger harm; the form stays on screen with its own button either way.
     */

    setSending(true);
    // Flagged, not blocking: the message goes either way, and the form stays up
    // with its own button so an unusable number can be corrected.
    setDetailsError(askForDetails && supplied && !usable ? 'invalid' : null);
    setDraft('');
    setFiles([]);
    setNotice(null);
    setSuggestions([]);
    insertAt.current = null;

    const outcome = await onSend(
      body,
      attached,
      askForDetails && !started && usable ? details : null,
    );
    if (!outcome.ok) {
      // Put the words and the files back rather than losing them, and say why.
      // A send with files can take a minute, and the box stays open while it
      // does: words typed meanwhile follow the ones put back, never replaced
      // by them. Files cannot be added meanwhile (the clip waits for the send),
      // so the ones put back are all there are.
      revealEnd.current = true;
      setDraft((typed) => withinLimit(typed.trim() ? `${body}\n${typed}` : body));
      setFiles(attached);
      setNotice(outcome.refusal);
    }
    setSending(false);
  }

  // --- Files ----------------------------------------------------------------

  function pickFiles(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // Emptied, so choosing the same file again — after removing it — is a
    // change the browser reports.
    event.target.value = '';
    if (picked.length === 0) return;

    const { admitted, refusal } = admitWidgetFiles(files, picked);
    setFiles(admitted);
    setNotice(refusal);
  }

  function removeFile(index: number, event: MouseEvent<HTMLButtonElement>) {
    setFiles((chosen) => chosen.filter((_, at) => at !== index));
    setNotice(null);
    // The button pressed is about to go, and focus with it; from the keyboard
    // it lands on the button that adds files, where the chips are about.
    if (event.detail === 0) attachButton.current?.focus();
  }

  // --- Emoji ----------------------------------------------------------------

  function toggleEmoji(event: MouseEvent<HTMLButtonElement>) {
    if (emojiOpen) {
      setEmojiOpen(false);
      return;
    }
    setEmojiTakesFocus(event.detail === 0);
    setEmojiOpen(true);
    // A phone's keyboard gives way to the panel, as its own emoji keyboard
    // does, so the conversation is not squeezed between the two.
    if (lastPointer.current === 'touch') composer.current?.blur();
  }

  const closeEmoji = useCallback(() => {
    setEmojiOpen(false);
    // Escape pressed inside the panel, whose focus is about to go with it.
    emojiButton.current?.focus();
  }, []);

  /**
   * Puts an emoji where the caret is, or over what is selected, as typing it
   * would. Into the focused box at its own selection; into an unfocused one at
   * the place the last emoji left (`insertAt`), or where the caret was when
   * it lost focus — which a field keeps until its value is set again.
   */
  function insertEmoji(emoji: string, pickedWith: PickedWith) {
    const field = composer.current;
    const focused = field !== null && document.activeElement === field;
    const start =
      !focused && insertAt.current !== null
        ? insertAt.current
        : (field?.selectionStart ?? draft.length);
    const end = !focused && insertAt.current !== null ? start : (field?.selectionEnd ?? start);
    const next = draft.slice(0, start) + emoji + draft.slice(end);
    // A value set from code is not held to `maxLength`, so this is.
    if (next.length > MAX_WIDGET_MESSAGE_CHARS) return;

    setDraft(next);
    const after = start + emoji.length;
    if (focused) {
      caretAt.current = after;
    } else if (pickedWith === 'mouse' && field) {
      // A click on a desktop goes back to the box, to carry on typing; a press
      // there never left it (`EmojiPicker`), so this is a box that had no
      // focus to begin with. A tap leaves a phone's keyboard down, and a key
      // leaves focus in the grid, where the arrows are.
      insertAt.current = null;
      field.focus();
      caretAt.current = after;
    } else {
      insertAt.current = after;
    }
  }

  /*
   * What each message is drawn as: a survey as its card, and a message with
   * files as the files and then its words, each a part of its own — a photo
   * does not sit inside a blue bubble — unless the words were only the
   * stand-in for the files, which the server sends as an empty body.
   */
  const parts = messages.flatMap((message): Part[] => {
    if (message.survey) return [{ message, part: 'survey' }];
    const attached = message.attachments ?? [];
    return [
      ...(attached.length > 0 ? [{ message, part: 'files' as const }] : []),
      ...(message.body.trim() || attached.length === 0 ? [{ message, part: 'text' as const }] : []),
    ];
  });

  /*
   * A run is one sender saying several things in a row. The author's name is
   * part of the key, so two agents answering back to back are two blocks, each
   * with its own name over it.
   */
  const runs = runPositions(parts, ({ message }) => `${message.from}:${message.authorName ?? ''}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
        {messages.length === 0 && !askForDetails ? (
          <p className="py-8 text-center text-sm text-(--color-text-secondary)">{copy.starter}</p>
        ) : null}

        {/*
          The visitor's own words are `out`: what they need from the layout is
          which of these they sent. No avatars, times or receipts, because the
          payload carries none of them — an agent's colour, a delivery state —
          and a tick drawn without a fact behind it is a promise.

          A `system` message is a reply no agent wrote, so it is dashed, and
          labelled in words as well: the border alone says nothing to a screen
          reader, nor to anybody who has not learned what dashes mean.
        */}
        {/*
          A survey is the card, not its message's text: the text is the
          help-centre link, kept for the console and for a widget loaded before
          the card existed, and a link out of the chat is the thing the card
          replaces. `attachment` because the card is a surface of its own.
        */}
        <ol className="flex flex-col">
          {parts.map(({ message, part }, index) => (
            <ChatBubble
              key={`${message.id}:${part}`}
              from={message.from === 'visitor' ? 'out' : 'in'}
              kind={part !== 'text' ? 'attachment' : message.from === 'system' ? 'bot' : 'message'}
              automated={message.from === 'system'}
              group={runs[index]}
              author={
                message.from === 'agent'
                  ? message.authorName
                  : message.from === 'system'
                    ? copy.automated
                    : undefined
              }
            >
              {part === 'survey' && message.survey ? (
                <SurveyCard survey={message.survey} onAnswer={onAnswerSurvey} />
              ) : part === 'files' ? (
                <WidgetFiles
                  files={message.attachments ?? []}
                  sendingLabel={copy.fileSending}
                  dir={direction(locale)}
                  align={message.from === 'visitor' ? 'end' : 'start'}
                />
              ) : (
                <p className="whitespace-pre-wrap">{message.body}</p>
              )}
            </ChatBubble>
          ))}
        </ol>

        <div ref={bottom} />
      </div>

      {askForDetails ? (
        <div className="shrink-0 border-t border-(--color-border-subtle) px-4 py-3">
          <p className="mb-2 text-xs text-(--color-text-secondary)">{copy.detailsPrompt}</p>
          <div className="flex flex-col gap-2">
            <input
              name="name"
              value={details.name}
              onChange={(event) => setDetails({ ...details, name: event.target.value })}
              placeholder={copy.namePlaceholder}
              autoComplete="name"
              className={FIELD}
            />
            <input
              name="email"
              type="email"
              dir="ltr"
              value={details.email}
              onChange={(event) => setDetails({ ...details, email: event.target.value })}
              placeholder={copy.emailPlaceholder}
              autoComplete="email"
              aria-invalid={detailsError ? true : undefined}
              aria-describedby={detailsHintId}
              className={FIELD}
            />
            <input
              name="phone"
              type="tel"
              dir="ltr"
              value={details.phone}
              onChange={(event) => setDetails({ ...details, phone: event.target.value })}
              placeholder={copy.phonePlaceholder}
              autoComplete="tel"
              aria-invalid={detailsError ? true : undefined}
              aria-describedby={detailsHintId}
              /* `tel`, not `number`: a leading zero and a '+' both matter, and a
                 spinner on a phone number is nonsense. */
              className={FIELD}
            />
          </div>
          <p
            id={detailsHintId}
            className={`mt-1.5 text-xs ${
              detailsError ? 'text-(--color-feedback-danger-fg)' : 'text-(--color-text-secondary)'
            }`}
          >
            {detailsError === 'invalid'
              ? copy.detailsInvalid
              : detailsError === 'missing'
                ? copy.detailsMissing
                : copy.detailsHint}
          </p>

          {started ? (
            <Button
              onClick={() => void saveDetails()}
              disabled={savingDetails}
              loading={savingDetails}
              className="mt-2"
            >
              {copy.send}
            </Button>
          ) : null}
        </div>
      ) : null}

      {!online && detailsSaved ? (
        <div className="shrink-0 border-t border-(--color-border-subtle) px-4 py-2">
          <SuccessText>{copy.detailsSaved}</SuccessText>
        </div>
      ) : null}

      {visibleSuggestions.length > 0 ? (
        <div className="shrink-0 border-t border-(--color-border-subtle) px-4 py-2">
          <p className="mb-1 text-xs text-(--color-text-secondary)">{copy.suggested}</p>
          <ul className="flex flex-col gap-1">
            {visibleSuggestions.map((article) => (
              <li key={article.slug}>
                <button
                  type="button"
                  onClick={() => onOpenArticle(article)}
                  className="text-start text-xs text-(--color-text-link) underline underline-offset-2 hover:text-(--color-text-link-hover)"
                >
                  {article.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        onSubmit={submit}
        className="flex shrink-0 flex-col border-t border-(--color-border-subtle) p-2.5"
      >
        {/*
          Polite rather than an alert: it answers what the visitor just did. On
          the page while empty, so it is in place to announce, and spaced by its
          sentence's margin rather than the column's gap, which an empty child
          still gets.
        */}
        <div aria-live="polite">
          {notice ? (
            <p className="mb-2">
              <ErrorText inline>{noticeText(notice, copy)}</ErrorText>
            </p>
          ) : null}
        </div>

        {files.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {files.map((file, index) => (
              <SelectedFile
                key={keyOf(file)}
                file={file}
                removeLabel={fill(copy.removeFile, { name: file.name })}
                onRemove={(event) => removeFile(index, event)}
              />
            ))}
          </ul>
        ) : null}

        <div className="flex items-end gap-2">
          {/*
            The two buttons sit inside the box, the smile at its start and the
            clip at its end, as the messenger most visitors here use every day
            has them — and so the panel's width still goes to what is being
            typed.
          */}
          <div className={WIDGET_COMPOSER_BOX}>
            <button
              ref={emojiButton}
              type="button"
              aria-label={copy.emoji}
              aria-expanded={emojiOpen}
              aria-controls={emojiOpen ? pickerId : undefined}
              onPointerDown={(event) => {
                lastPointer.current = event.pointerType === 'touch' ? 'touch' : 'mouse';
                // On a desktop, leaves the caret in the box where the emoji will go.
                if (event.pointerType !== 'touch') event.preventDefault();
              }}
              onClick={toggleEmoji}
              className={COMPOSER_BUTTON}
            >
              <SmileIcon size={20} />
            </button>

            <textarea
              ref={composer}
              value={draft}
              onChange={(event) => {
                insertAt.current = null;
                setDraft(event.target.value);
              }}
              onFocus={(event) => {
                // Back from the keyboard after emoji picked elsewhere: the caret
                // goes after the last of them, not to the end the value change
                // put it at. A click or a tap places its own, where it landed.
                const at = insertAt.current;
                insertAt.current = null;
                if (at !== null && !pressingBox.current)
                  event.currentTarget.setSelectionRange(at, at);
              }}
              onPointerDown={(event) => {
                pressingBox.current = true;
                boxPointer.current = event.pointerType;
              }}
              onPointerUp={() => (pressingBox.current = false)}
              onPointerCancel={() => (pressingBox.current = false)}
              onClick={() => {
                // Touching the box brings a phone's keyboard back, which takes
                // the panel's place. On the click, once the tap has landed and
                // placed its caret: closed on the press, the panel went before
                // the tap was delivered, the box moved down from under the
                // finger, and the tap fell on whatever was there instead.
                if (boxPointer.current === 'touch' && emojiOpen) setEmojiOpen(false);
                boxPointer.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && emojiOpen) {
                  event.preventDefault();
                  setEmojiOpen(false);
                  return;
                }
                // Enter sends, Shift+Enter breaks the line — what every chat does,
                // and what a visitor will try without thinking.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit(event);
                }
              }}
              /* The floor, and what the box is before the effect above has
                 measured it. One line: 24px of 16px text inside 10px of
                 padding each side is the 44px of the buttons beside it, so
                 the placeholder and the caret sit on the line the smile and
                 the clip sit on. Two rows put the words on the first line
                 and the buttons, held to the box's bottom so they stay
                 beside the last line as it grows, on the second. */
              rows={1}
              maxLength={MAX_WIDGET_MESSAGE_CHARS}
              placeholder={copy.placeholder}
              dir="auto"
              /*
                16px, not the 14px the rest of the widget reads at. Safari zooms
                the page in on any field smaller than that the moment it is
                focused, and a zoomed page is a scrolled page — which on iOS is
                what parts a caret from the field it belongs to. Sizing the field
                up is the fix that does not also disable pinch-zoom for the
                visitor.

                No outline of its own: the box round it draws the keyboard ring
                while the textarea has focus (`WIDGET_COMPOSER_BOX`), so the
                whole control is ringed rather than the text area inside it.

                The placeholder is held to one line and cut short rather than
                wrapped. On a 320px phone "Type your message…" is wider than the
                box, and Chrome counts a wrapped placeholder in `scrollHeight`,
                so the effect above grew the empty box to two lines and put the
                words above the buttons again. `text-ellipsis` on the textarea
                as well as on its placeholder: Chrome reads a textarea
                placeholder's `text-overflow` off the textarea, and without it
                cut the hint off mid-letter. Typed text still wraps, so it
                never overflows a line for the ellipsis to act on.
              */
              className="min-w-0 flex-1 resize-none bg-transparent px-1 py-2.5 font-conversation text-base text-ellipsis text-(--color-text-primary) outline-none placeholder:truncate placeholder:text-(--color-text-tertiary)"
            />

            <button
              ref={attachButton}
              type="button"
              aria-label={copy.attach}
              onClick={() => fileInput.current?.click()}
              // While a send is on the wire: what it carries comes back if it
              // fails, and a file added meanwhile would have nowhere to go.
              disabled={sending}
              className={COMPOSER_BUTTON}
            >
              <PaperclipIcon size={20} />
            </button>
            {/*
              Hidden rather than visually hidden: `sr-only` is positioned
              against the nearest positioned box, and the button above is what
              a person reaches. A hidden input still opens its picker when the
              button clicks it, in every engine.
            */}
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={WIDGET_ACCEPT}
              onChange={pickFiles}
              tabIndex={-1}
              aria-hidden
              className="hidden"
            />
          </div>

          {/*
            The word is the button's name rather than its face: a 380px panel
            spends its width on what the visitor is typing. `!` on the box because
            the shared button's height and padding are set per size, and a second
            utility on the same property wins or loses by Tailwind's order, not
            this one's.

            As tall as the box beside it: the 44px of the buttons inside, and
            the box's border, 1px above and below. At 44px it sat on the box's
            bottom edge with its centre a pixel under theirs and its top two
            under the box's; square, so it is still a round-cornered tile.
          */}
          <Button
            type="submit"
            disabled={sending || (!draft.trim() && files.length === 0)}
            loading={sending}
            aria-label={copy.send}
            icon={<SendIcon size={18} />}
            className="min-h-[calc(var(--tap-min)+2px)]! min-w-[calc(var(--tap-min)+2px)] px-0!"
          />
        </div>

        {emojiOpen ? (
          <div className="mt-2">
            <EmojiPicker
              id={pickerId}
              label={copy.emojiPanel}
              takeFocus={emojiTakesFocus}
              onPick={insertEmoji}
              onClose={closeEmoji}
            />
          </div>
        ) : null}
      </form>
    </div>
  );
}

export type OfflineDetails = { name: string; email: string; phone: string };

/** Why a send or a file was refused: a file's own reason, the upload budget, or anything else. */
export type SendRefusal = WidgetFileRefusal | { reason: 'slow_down' } | { reason: 'failed' };

/** What a send came to. A refusal puts the words and the files back. */
export type SendOutcome = { ok: true } | { ok: false; refusal: SendRefusal };

type Part = { message: Message; part: 'survey' | 'files' | 'text' };

/*
  A chosen file has no id until it is stored, and its place in the list moves
  when one before it is removed, so each `File` gets a key of its own: keyed by
  place, removing the first photo remounted every chip after it and made each
  thumbnail again.
*/
const fileKeys = new WeakMap<File, number>();
let lastFileKey = 0;

function keyOf(file: File): number {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = ++lastFileKey;
    fileKeys.set(file, key);
  }
  return key;
}

/**
 * Words put back after a failed send, joined to those typed while it was on the
 * wire, held to the limit the box keeps while typing — a value set from code is
 * not — so the visitor sees in the box what the route would keep, rather than
 * the route cutting the end off unseen. Never through the middle of an emoji
 * or another character written as two code units.
 */
function withinLimit(text: string): string {
  if (text.length <= MAX_WIDGET_MESSAGE_CHARS) return text;
  const cut = text.slice(0, MAX_WIDGET_MESSAGE_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A ghost button inside the composer's box, a full tap target around a 20px glyph. */
const COMPOSER_BUTTON =
  'inline-flex size-(--tap-min) shrink-0 items-center justify-center rounded-md text-(--color-text-secondary) transition-colors hover:bg-(--color-background-hover) hover:text-(--color-text-primary) active:bg-(--color-background-pressed) aria-expanded:text-(--color-text-brand)';

const MEGABYTE = 1024 * 1024;

/** The sentence a refusal is told in, with the visitor's file name isolated inside it. */
function noticeText(notice: SendRefusal, copy: WidgetCopy): ReactNode {
  const limit = `${MAX_WIDGET_FILE_BYTES / MEGABYTE} ${copy.megabytes}`;
  switch (notice.reason) {
    case 'type':
      return fill(copy.fileType, { name: notice.filename });
    case 'empty':
      return fill(copy.fileEmpty, { name: notice.filename });
    case 'too_large':
      return fill(copy.fileTooLarge, { name: notice.filename, limit });
    case 'too_large_total':
      return fill(copy.filesTooLarge, { limit });
    case 'too_many':
      return fill(copy.filesTooMany, { count: String(MAX_WIDGET_FILES) });
    case 'slow_down':
      return copy.filesSlowDown;
    case 'failed':
      return copy.sendFailed;
  }
}

/**
 * A sentence from the copy with its `{placeholders}` filled in. The file name
 * is drawn in a `<bdi>`, so a Latin name inside an Arabic sentence — or an
 * Arabic one inside English — keeps its own order without reordering the
 * words around it.
 */
function fill(template: string, values: { name?: string; limit?: string; count?: string }) {
  const text = template
    .replaceAll('{limit}', values.limit ?? '')
    .replaceAll('{count}', values.count ?? '');
  if (values.name === undefined) return text;
  const [before, ...after] = text.split('{name}');
  return (
    <>
      {before}
      <bdi>{values.name}</bdi>
      {after.join(values.name)}
    </>
  );
}

/**
 * A file chosen for the next message: a thumbnail for a photo the browser can
 * draw, its kind's glyph for anything else, its name and size, and the button
 * that takes it out again.
 *
 * The thumbnail is the file itself through an object URL, which holds the file
 * in memory until it is revoked, so the URL is made and revoked by the image's
 * own ref: React calls the cleanup when the image goes, and calls the callback
 * again — with a new URL — if the file changes.
 */
function SelectedFile({
  file,
  removeLabel,
  onRemove,
}: {
  file: File;
  removeLabel: ReactNode;
  onRemove: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const thumbnail = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return;
      const url = URL.createObjectURL(file);
      image.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file],
  );
  const family = mediaFamily(file.type);
  const labelId = useId();

  return (
    <li className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-(--color-border-subtle) bg-(--color-background-surface) py-1 ps-1 pe-0.5 text-xs">
      {isPreviewableImage(file.type) ? (
        // eslint-disable-next-line @next/next/no-img-element -- an object URL for a file still on the visitor's device
        <img
          ref={thumbnail}
          alt=""
          className="size-8 shrink-0 rounded-md bg-(--color-background-surface-sunken) object-cover"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-(--color-background-surface-sunken) text-(--color-text-tertiary)">
          {family ? <PaperclipIcon size={16} /> : <DocumentIcon size={16} />}
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <bdi className="truncate text-(--color-text-primary)">{file.name}</bdi>
        {/* Left to right in either language: "125 B", not "B 125". */}
        <span dir="ltr" className="self-start text-(--color-text-tertiary) tabular-nums">
          {formatBytes(file.size)}
        </span>
      </span>
      <span id={labelId} hidden>
        {removeLabel}
      </span>
      <button
        type="button"
        aria-labelledby={labelId}
        onClick={onRemove}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-(--color-text-secondary) transition-colors hover:bg-(--color-background-hover) hover:text-(--color-text-primary)"
      >
        <XIcon size={16} />
      </button>
    </li>
  );
}

/* Roughly six lines. Past that the composer would be eating the transcript,
   which is the half of the panel that carries the agent's answer. */
const MAX_COMPOSER_PX = 160;

/*
  Shared by the three fields. A step shorter than the composer, so three of
  them, their hint and the composer still fit a 600px panel with the
  conversation showing above them.
*/
const FIELD = `${WIDGET_FIELD} px-3 py-1.5`;
