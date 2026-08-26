'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorText } from '@/components/ui';
import { labelFor, moderatableComment, readCommentModeration } from '@/lib/meta/moderation';
import { moderateComment, type ActionState } from '../../actions';

const INITIAL: ActionState = { error: null };

/**
 * Hide, unhide and delete, under a customer's public comment.
 *
 * Only under an *inbound* one: an outbound row carries no `commentId` until Meta
 * has accepted it, and deleting our own published answer is a different act
 * with a different audience — the customer who was answered — so it is not
 * folded in here.
 *
 * The state is rendered for every agent and the buttons only for those who hold
 * `ticket.moderate_comment`. Somebody without the permission still needs to know
 * that a comment they are reading is hidden from the public, because it changes
 * what their reply should say.
 */
export function CommentModeration({
  messageId,
  meta,
  canModerate,
}: {
  messageId: string;
  meta: Record<string, unknown>;
  canModerate: boolean;
}) {
  const comment = moderatableComment(meta);
  if (!comment) return null;

  const state = readCommentModeration(meta);

  // Nothing has been done and nobody here can do anything: no strip at all,
  // rather than an empty row under every comment in the archive.
  if (!canModerate && !state.hidden && !state.deleted && !state.pending) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
      {state.deleted ? (
        <Badge tone="danger">deleted from the post</Badge>
      ) : state.hidden ? (
        <Badge tone="warning">hidden from the public</Badge>
      ) : null}

      {state.pending ? (
        <span className="text-xs opacity-60">{labelFor(state.pending)} at Meta…</span>
      ) : null}

      {canModerate && !state.deleted && !state.pending ? (
        <>
          <ModerationForm
            messageId={messageId}
            action={state.hidden ? 'unhide' : 'hide'}
            label={state.hidden ? 'Unhide' : 'Hide'}
          />
          <ModerationForm
            messageId={messageId}
            action="delete"
            label="Delete"
            // Irreversible, and it removes somebody's words from a public
            // thread. One extra click is the whole guard — this codebase has no
            // modals, and a second click on the same button is what every other
            // destructive action in the console asks for.
            confirmLabel="Really delete?"
          />
        </>
      ) : null}

      {state.error ? <ModerationError>{state.error}</ModerationError> : null}
    </div>
  );
}

function ModerationForm({
  messageId,
  action,
  label,
  confirmLabel,
}: {
  messageId: string;
  action: 'hide' | 'unhide' | 'delete';
  label: string;
  confirmLabel?: string;
}) {
  const [state, formAction] = useActionState(moderateComment, INITIAL);
  const [armed, setArmed] = useState(false);
  const router = useRouter();

  // The comment's own state lives on the message row, so the strip only tells
  // the truth again once the page has re-read it.
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.nonce, router]);

  return (
    <form action={formAction} className="inline-flex items-center gap-1.5">
      <input type="hidden" name="messageId" value={messageId} />
      <input type="hidden" name="action" value={action} />

      {confirmLabel && !armed ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setArmed(true)}>
          {label}
        </Button>
      ) : (
        <ModerationSubmit label={confirmLabel && armed ? confirmLabel : label} danger={armed} />
      )}

      <ErrorText>{state.error}</ErrorText>
    </form>
  );
}

function ModerationSubmit({ label, danger }: { label: string; danger: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" variant={danger ? 'danger' : 'ghost'} disabled={pending}>
      {pending ? 'Asking Meta…' : label}
    </Button>
  );
}

/**
 * Graph's refusal, kept on the comment it refers to.
 *
 * Deliberately not a toast: it is often the useful half of the story — "this
 * comment no longer exists", "the app is not approved for comment management" —
 * and an agent needs it while they decide what to do next, not for four seconds.
 */
function ModerationError({ children }: { children: string }) {
  return (
    <span className="text-xs text-red-600 dark:text-red-400">Meta refused it: {children}</span>
  );
}
