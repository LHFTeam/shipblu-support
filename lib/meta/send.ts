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
 * The disagreement between the two platforms is `messaging_type`, and this
 * module changes only half of it deliberately.
 *
 * Meta's Send API reference documents `messaging_type` for Messenger and lists
 * `RESPONSE`, `UPDATE` and `MESSAGE_TAG`. Neither Instagram send reference has it
 * — not the Messenger-Platform one for Instagram messaging over a Page, and not
 * the Instagram-Login one on `graph.instagram.com`. Both list `recipient`,
 * `message`, `sender_action`, `payload` and `reply_to`, and describe the human
 * agent case as tagging the response, with no `messaging_type` anywhere in it.
 *
 * **So the tagged Instagram body drops it and the in-window one keeps it.** That
 * asymmetry is the point, and it is a statement about evidence rather than about
 * Meta. The tagged path has never once succeeded: the single real `HUMAN_AGENT`
 * send this app has made was an Instagram reply that failed eight times with
 * Graph naming no reason (`docs/PROJECT-STATE.md` §5.2), and an undocumented
 * parameter alongside a tag is a live candidate for it. The in-window path is
 * this channel's working traffic, and it works *today* with `messaging_type:
 * RESPONSE` on it. Nothing establishes that shape is wrong, and no local test
 * could: when `INSTAGRAM_ACCESS_TOKEN` is unset the call goes out over the Page
 * connection to `graph.facebook.com`, where the parameter is documented as part
 * of every send. Removing it there on the strength of a doc page that describes
 * a different host would risk every in-window Instagram reply to fix a send that
 * has never worked — the wrong trade in the wrong direction.
 *
 * The axis is the **platform**, not the connection. That is the narrower and the
 * more surprising reading — `lib/meta/connection.ts` exists precisely because
 * the two Instagram connections differ in host, token, ids and field vocabulary —
 * but this parameter is absent from the Instagram product on both of them, and
 * branching on the connection would leave the Page-borne half of Instagram
 * sending a Messenger body to an Instagram inbox.
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

  if (input.tag === 'HUMAN_AGENT') {
    // Instagram's send reference has no `messaging_type` on either connection,
    // so the tag travels alone here. Messenger's documents it, and `MESSAGE_TAG`
    // is what carries a tag at all.
    if (input.platform === 'facebook') body.messaging_type = 'MESSAGE_TAG';
    body.tag = 'HUMAN_AGENT';
    return body;
  }

  // Untouched on both platforms: this is the shape the channel's live traffic
  // already sends successfully, and the header above says why it is not being
  // "corrected" toward a doc page that names a different host.
  body.messaging_type = 'RESPONSE';

  return body;
}
