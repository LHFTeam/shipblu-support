/**
 * Taking thread control back from whichever app currently holds it.
 *
 * The handover protocol belongs to the **Facebook Page** and to nothing else —
 * `lib/meta/connection.ts` has the table, and `lib/meta/thread.ts` the
 * consequence: a customer's message arriving in the webhook's `standby` array
 * says another app is answering this inbox, and Meta will refuse a send from
 * this one until that changes. Everything else about that refusal is outside
 * this codebase — an approval, a token, a retry all leave it exactly where it
 * was — but *this* is the one lever the protocol actually exposes to us.
 *
 * A pure module for the same reason `lib/meta/send.ts` and `lib/meta/comments.ts`
 * are pure ones: **a wrong request shape is invisible in the response.** Graph
 * answers a body it dislikes with `100 "Unsupported post request…"`, which is
 * word for word what it says about a thread that does not exist. So the shape is
 * written down here from the reference and asserted in a unit test, which is the
 * only check available — nothing local can call Graph.
 *
 * The reference is Messenger Platform → Handover Protocol → Conversation
 * Control. Two things on it decide everything below:
 *
 * - **Only the primary receiver may take control.** A secondary receiver has
 *   `request_thread_control` instead, which asks the primary app to hand over
 *   and is answered by whoever runs *that* tool rather than by Meta. So this
 *   call failing is not necessarily a bug in the request: it is the protocol
 *   saying this app is not the one entitled to make it, and
 *   `describeTakeControlFailure` in `lib/meta/errors.ts` is where that is turned
 *   into a sentence an agent can act on.
 * - **`metadata` is delivered to the app losing control**, in its own
 *   `take_thread_control` webhook. It is the only thing we can put in front of
 *   whoever is looking at the other tool wondering why a thread went quiet, so
 *   it names this system rather than being left off.
 *
 * The endpoint is addressed to the Page node. Meta's reference spells it
 * `/me/take_thread_control`, and `me` under a Page token *is* that node — the
 * caller names the id outright for the reason `sendDirectMessage` does the same
 * with `/me/messages`: an id that can be read in a log line is worth more than
 * one resolved from whichever credential happened to be in the environment.
 */

export type TakeThreadControlRequest = {
  recipient: { id: string };
  metadata?: string;
};

/**
 * What we tell the app we are taking the thread from.
 *
 * Deliberately not the agent's name. This string leaves our system for a third
 * party's logs, and which of our people pressed the button is our business;
 * that half is recorded on the ticket's own timeline instead, where the people
 * entitled to see it already are.
 */
export const TAKE_CONTROL_METADATA = 'Taken by the ShipBlu Support console';

export function takeThreadControlRequest(input: {
  recipientId: string;
  metadata?: string;
}): TakeThreadControlRequest {
  const body: TakeThreadControlRequest = { recipient: { id: input.recipientId } };

  const metadata = input.metadata ?? TAKE_CONTROL_METADATA;
  // Sent only when there is something to say. An empty string is a value Graph
  // would carry through to the other app's webhook, where a blank line is worse
  // than a missing field: it reads as a message somebody meant to write.
  if (metadata) body.metadata = metadata;

  return body;
}
