'use client';

import { ErrorText, Textarea } from '@/components/ui';
import { addNote } from '../../reply-actions';
import { INITIAL } from './form-state';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';
import { useRefreshOnSuccess } from '@/components/use-refresh-on-success';

export function NoteForm({
  conversationId,
  onSent,
}: {
  conversationId: string;
  onSent?: () => void;
}) {
  const { state, key, form } = useActionForm(addNote, INITIAL);
  useRefreshOnSuccess(state, onSent);

  return (
    <form key={key} {...form} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />

      <Textarea
        name="body"
        rows={3}
        placeholder="Visible to agents only — never sent to the customer."
        className="border-amber-500/40 bg-amber-500/5"
        required
      />

      <ErrorText>{state.error}</ErrorText>

      <SubmitButton className="self-end" idle="Add note" busy="Saving…" />
    </form>
  );
}
