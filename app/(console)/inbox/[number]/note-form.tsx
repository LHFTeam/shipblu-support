'use client';

import { LockIcon } from '@/components/icons';
import { ErrorText, Textarea } from '@/components/ui';
import { addNote } from '../../reply-actions';
import { INITIAL } from './form-state';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

export function NoteForm({
  conversationId,
  onSent,
}: {
  conversationId: string;
  onSent?: () => void;
}) {
  const { state, key, form } = useActionForm(addNote, INITIAL, { onSuccess: onSent });

  return (
    <form key={key} {...form} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />

      {/* Said in words above the box, not left to the amber: the colour is
          what an agent notices, the sentence is what they can check. */}
      <p className="flex items-center gap-1.5 text-xs font-semibold text-(--color-message-note-fg)">
        <LockIcon size={14} className="shrink-0" />
        Only ShipBlu staff see notes. Nothing here is sent to the customer.
      </p>

      <Textarea
        name="body"
        rows={3}
        dir="auto"
        tone="note"
        placeholder="Visible to agents only — never sent to the customer."
        required
      />

      <ErrorText>{state.error}</ErrorText>

      <SubmitButton
        className="self-end"
        variant="note"
        icon={<LockIcon size={15} />}
        idle="Add note"
        busy="Saving…"
      />
    </form>
  );
}
