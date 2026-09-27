/**
 * What a form's server action answers, and the success it answers with.
 *
 * Four action files each had their own `ok()`, identical but for the name of
 * the state it returned. A state that needs more, like the console's `message`,
 * is this and its own fields.
 *
 * Pure, so a client form can import it as well as an action can.
 */
export type ActionState = {
  error: string | null;
  ok?: boolean;
  /**
   * Changes on every success. The composer keys its form on this so a second
   * consecutive send still clears the textarea — `ok: true` alone is the same
   * value twice and would leave the previous reply sitting in the box.
   */
  nonce?: number;
};

export function ok(): ActionState {
  return { error: null, ok: true, nonce: Date.now() };
}
