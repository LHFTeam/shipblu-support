import type { MetaPlatform } from './types';

/**
 * The direct-message request, per platform.
 *
 * A pure module for the same reason `lib/meta/comments.ts` is one, and it is
 * worth restating because this is the second time the same trap has been found
 * on this channel: **a wrong request shape is invisible in the response**. Graph
 * answers a body it does not like with `100 "Unsupported post request…"` or with
 * a bare "An unknown error has occurred.", which is word for word what it says
 * about a customer who blocked the account. So the shapes are written down here
 * from the node reference and asserted in a unit test — the only check available,
 * since nothing local can call Graph.
 *
 * The disagreement between the two platforms is `messaging_type`:
 *
 * | | Messenger (a Page) | Instagram (either connection) |
 * | --- | --- | --- |
 * | host | `graph.facebook.com` | `graph.facebook.com` or `graph.instagram.com` |
 * | `messaging_type` | documented, and `MESSAGE_TAG` is what carries a tag | **not a parameter at all** |
 * | `tag` | with `messaging_type: MESSAGE_TAG` | on its own |
 *
 * Meta's Send API reference documents `messaging_type` for Messenger and lists
 * `RESPONSE`, `UPDATE` and `MESSAGE_TAG`. Neither Instagram send reference has it
 * — not the Messenger-Platform one for Instagram messaging over a Page, and not
 * the Instagram-Login one on `graph.instagram.com`. Both list `recipient`,
 * `message`, `sender_action`, `payload` and `reply_to`, and describe the human
 * agent case as tagging the response, with no `messaging_type` anywhere in it.
 *
 * So the axis is the **platform**, not the connection. That is the narrower and
 * the more surprising reading — `lib/meta/connection.ts` exists precisely because
 * the two Instagram connections differ in host, token, ids and field vocabulary —
 * but this particular parameter is absent from the Instagram product on both of
 * them, and branching on the connection would leave the Page-borne half of
 * Instagram sending a Messenger body to an Instagram inbox.
 *
 * Sending an undocumented parameter is not free. It is the standing candidate
 * for the one real `HUMAN_AGENT` send this app has made — an Instagram reply on
 * 2026-08-20 that failed eight times and died in the queue, with Graph naming no
 * reason (`docs/PROJECT-STATE.md` §5.2). That is a hypothesis and not a
 * diagnosis: the Human Agent permission has never been confirmed approved
 * either, and it remains the likelier cause. Removing the parameter is right on
 * the documentation regardless of which one it was.
 */

export type DirectMessageRequest = {
  recipient: { id: string };
  message: { text: string };
  messaging_type?: 'RESPONSE' | 'MESSAGE_TAG';
  tag?: 'HUMAN_AGENT';
};

export function directMessageRequest(input: {
  platform: MetaPlatform;
  recipientId: string;
  text: string;
  tag: 'RESPONSE' | 'HUMAN_AGENT';
}): DirectMessageRequest {
  const body: DirectMessageRequest = {
    recipient: { id: input.recipientId },
    message: { text: input.text },
  };

  // Instagram's send reference has no `messaging_type`, on either connection, so
  // the tag travels alone. `RESPONSE` there is not a value to send — it is this
  // codebase's word for "inside the window, nothing to declare".
  if (input.platform === 'facebook') {
    body.messaging_type = input.tag === 'HUMAN_AGENT' ? 'MESSAGE_TAG' : 'RESPONSE';
  }

  if (input.tag === 'HUMAN_AGENT') body.tag = 'HUMAN_AGENT';

  return body;
}
