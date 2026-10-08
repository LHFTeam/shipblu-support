import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  CannedSuggestion,
  CannedSuggestionAnswer,
  SuggestionEvent,
} from '@/lib/canned-suggest/types';

/**
 * Asking `/api/canned-suggestions` which canned response fits, and remembering
 * what the agent did with the answer — the half of the reply box's suggestion
 * that is not drawing it.
 *
 * Asked when the box takes focus while empty, and again when a new message
 * arrives while it is focused and empty — never while the agent is typing, and
 * at most once per newest message from this composer. The server keeps its own
 * one-call-per-message rule as well, so a remount after a tab switch is answered
 * from the stored row rather than from the provider.
 *
 * A fetch with an `AbortController` rather than a server action, for the reason
 * the route gives: Next queues a client's actions one behind another, and the
 * reply's Send must never wait for this.
 */

/** How often a composer that lost the race to another tab asks again. */
const MAX_RETRIES = 3;

function report(id: string, event: SuggestionEvent) {
  // `keepalive`, the `/api/focus` shape: an accept followed at once by Send
  // remounts this component, and the report must still arrive.
  void fetch(`/api/canned-suggestions/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event }),
    keepalive: true,
  }).catch(() => undefined);
}

export function useCannedSuggestion({
  conversationId,
  suggest,
  anchorMessageId,
  bodyRef,
}: {
  conversationId: string;
  suggest: boolean;
  anchorMessageId: string | null;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [suggestion, setSuggestion] = useState<CannedSuggestion | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);

  const askedFor = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const shownId = useRef<string | null>(null);

  // Only ever the suggestion for the message on screen now. One for an older
  // anchor disappears the moment the customer writes again, rather than
  // offering an answer to the message before.
  const current = suggestion?.anchorMessageId === anchorMessageId ? suggestion : null;
  // Nothing to show once the switch is off, even for an answer already held:
  // the switch is the rollback, and an open composer learns it on its next
  // refresh — a ghost left behind would still take Tab with no hint saying so.
  const showable =
    suggest && current?.cannedResponseId && current.id !== dismissedId && current.id !== acceptedId
      ? current
      : null;

  const request = useCallback(async (): Promise<void> => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch('/api/canned-suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId }),
          signal: controller.signal,
        });
        if (!response.ok) {
          // Let the next focus try again; the server answers a repeat cheaply.
          askedFor.current = null;
          return;
        }

        const answer = (await response.json()) as CannedSuggestionAnswer;
        if (controller.signal.aborted) return;

        if (answer.state === 'ready') setSuggestion(answer.suggestion);
        if (answer.state !== 'pending' || attempt >= MAX_RETRIES) return;

        // Another tab is asking the same question; its answer will be stored.
        // Wait for it only while the agent is still sitting in an empty box.
        await new Promise((resolve) => window.setTimeout(resolve, answer.retryAfterMs));
        const box = bodyRef.current;
        if (controller.signal.aborted) return;
        if (!box || document.activeElement !== box || box.value.trim()) {
          askedFor.current = null;
          return;
        }
      }
    } catch {
      // Aborted, offline, or an answer that was not JSON: no suggestion, which
      // is exactly what the box showed before this existed.
      if (!controller.signal.aborted) askedFor.current = null;
    }
  }, [conversationId, bodyRef]);

  const ask = useCallback(() => {
    if (!suggest || !anchorMessageId || askedFor.current === anchorMessageId) return;
    askedFor.current = anchorMessageId;
    void request();
  }, [suggest, anchorMessageId, request]);

  // A new message while the agent sits in an empty box is a new question.
  useEffect(() => {
    const box = bodyRef.current;
    if (box && document.activeElement === box && !box.value.trim()) ask();
  }, [ask, bodyRef]);

  // The composer unmounts on a tab switch and on every send; nothing should land
  // in a component that is gone. The server finishes the call regardless and
  // keeps the answer for the next focus.
  useEffect(() => {
    const flights = inFlight;
    return () => flights.current?.abort();
  }, []);

  const showableId = showable?.id ?? null;

  /** Once per suggestion, the first time its ghost text is actually on screen. */
  const markShown = useCallback(() => {
    if (!showableId || shownId.current === showableId) return;
    shownId.current = showableId;
    report(showableId, 'shown');
  }, [showableId]);

  const accept = useCallback(() => {
    if (!showableId) return;
    setAcceptedId(showableId);
    report(showableId, 'accepted');
  }, [showableId]);

  const dismiss = useCallback(() => {
    if (!showableId) return;
    setDismissedId(showableId);
    report(showableId, 'dismissed');
    // Back to the box: × is a button, and the agent was about to type.
    bodyRef.current?.focus();
  }, [showableId, bodyRef]);

  return {
    /** The suggestion to draw, or null — nothing to show, waved away, or already taken. */
    showable,
    /**
     * Which suggestion the reply should be graded against: the one this box was
     * offered for the message on screen — shown or not, `none` included — or,
     * when the conversation moved on and nothing newer was asked, the one the
     * agent took earlier, whose text is presumably still in the box. The newer
     * one wins, because the reply answers the newer message. Posted with Send;
     * the server re-reads it.
     */
    linkId: current?.id ?? acceptedId ?? null,
    ask,
    accept,
    dismiss,
    markShown,
  };
}
