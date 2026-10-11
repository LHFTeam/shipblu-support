'use client';

import { ErrorText, Input } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';
import { INITIAL } from '../forms-shared';
import { saveTrackingPhrase } from './actions';

/**
 * One phrase, editable in place.
 *
 * Not a `Disclosure` like the other admin editors: those open a form with a
 * dozen fields, and this is one text box. Hiding a single input behind a click
 * on a screen whose whole purpose is comparing twenty-three phrases would make
 * the comparison impossible.
 *
 * The box shows the default as a placeholder when nothing is saved, so an admin
 * reads the wording that is actually live either way — a blank box beside the
 * word "default" would leave them guessing what the default is. Clearing a saved
 * box and saving resets it, which is why there is no separate reset control.
 *
 * `dir="rtl"` because the field is Arabic. Without it the caret starts on the
 * wrong side and punctuation lands at the wrong end of the phrase — in an editor
 * for Arabic copy, on a console that is otherwise LTR.
 */
export function PhraseEditor({
  phraseKey,
  fallback,
  saved,
}: {
  phraseKey: string;
  fallback: string;
  saved: string;
}) {
  const { state, form } = useActionForm(saveTrackingPhrase, INITIAL);

  return (
    <form {...form} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input type="hidden" name="key" value={phraseKey} />
        <Input
          name="ar"
          dir="rtl"
          lang="ar"
          defaultValue={saved}
          placeholder={fallback}
          aria-label={`Arabic wording for ${phraseKey}`}
          className="min-w-0 flex-1"
        />
        <SubmitButton idle="Save" variant="secondary" />
      </div>
      <ErrorText>{state.error}</ErrorText>
    </form>
  );
}
