import type { ActionState } from '../../action-state';

export const INITIAL: ActionState = { error: null };

/**
 * What a composer form that writes to somebody says when its action never
 * answered. The send may have landed, and a blind retry is a second message to
 * the customer or the hub, so it names the place to look first. Handed to
 * `useActionForm` as `lost`; the hook's own sentence is for forms whose retry
 * reaches nobody.
 */
export const LOST_SEND =
  'No answer came back, so this may or may not have been sent. Check the timeline before sending it again.';
