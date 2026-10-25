'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Badge, Button, ErrorText } from '@/components/ui';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { labelFor, moderatableComment, readCommentModeration } from '@/lib/meta/moderation';
import { moderateComment } from '../../meta-actions';
import { INITIAL } from './form-state';

/**
 * Hide, unhide and delete, under a customer's public comment.
 *
 * Only under an *inbound* one: an agent's reply on a comment ticket names the
 * comment it answers in `commentId`, which is not the reply itself, and deleting
 * our own published answer is a different act with a different audience — the
 * customer who was answered — so it is not folded in here. `moderatableComment`
 * takes the direction for that reason.
 *
 * The state is rendered for every agent and the buttons only for those who hold
 * `ticket.moderate_comment`. Somebody without the permission still needs to know
 * that a comment they are reading is hidden from the public, because it changes
 * what their reply should say.
 */
export function CommentModeration({
  messageId,
  direction,
  meta,
  canModerate,
}: {
  messageId: string;
  direction: 'inbound' | 'outbound';
  meta: Record<string, unknown>;
  canModerate: boolean;
}) {
  const comment = moderatableComment(meta, direction);
  if (!comment) return null;

  const state = readCommentModeration(meta);

  // Nothing has been done and nobody here can do anything: no strip at all,
  // rather than an empty row under every comment in the archive.
  if (!canModerate && !state.hidden && !state.deleted && !state.pending) return null;

  return (
    // Under the comment's bubble, on the thread's own background: a control
    // inside the bubble would read as part of what the customer wrote.
    <div className="flex flex-wrap items-center gap-2 px-1">
      {state.deleted ? (
        <Badge tone="danger">Deleted from the post</Badge>
      ) : state.hidden ? (
        <Badge tone="warning">Hidden from the public</Badge>
      ) : null}

      {state.pending ? (
        <span className="text-xs text-(--color-text-tertiary)">
          {labelFor(state.pending)} at Meta…
        </span>
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
            // modals, and a second click on the same button is what every
            // admin delete asks for too (ConfirmSubmit).
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

  return (
    <form action={formAction} className="inline-flex items-center gap-1.5">
      <input type="hidden" name="messageId" value={messageId} />
      <input type="hidden" name="action" value={action} />

      {confirmLabel ? (
        <ConfirmSubmit label={label} confirmLabel={confirmLabel} busy={BUSY} />
      ) : (
        <ModerationSubmit label={label} />
      )}

      <ErrorText>{state.error}</ErrorText>
    </form>
  );
}

const BUSY = 'Asking Meta…';

function ModerationSubmit({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" variant="ghost" disabled={pending} loading={pending}>
      {pending ? BUSY : label}
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
  return <ErrorText inline>Meta refused it: {children}</ErrorText>;
}
