import { directMessageRequest, type DirectMessageRequest } from './send';
import type { MetaPlatform } from './types';

/**
 * The satisfaction survey as five quick replies: Instagram's survey, and
 * Facebook's when Messenger refuses its feedback card.
 *
 * A quick reply is a button under a message; tapping it sends its title as
 * the customer's message and hands our `payload` back on the webhook, in
 * `message.quick_reply.payload`. So the payload is what pairs the tap with
 * the survey — `csat:<survey id>:<rating>` — and the parser files a message
 * carrying one as an answer, never as something the customer said
 * (`lib/meta/parse.ts`): "Great" filed as a reply would reopen the ticket,
 * restart its clock and become its inbox preview.
 *
 * Built on `directMessageRequest`'s in-window body, `messaging_type: RESPONSE`
 * included on both platforms, because that is the shape this channel's live
 * traffic sends successfully today (`send.ts` says why it is not "corrected").
 * Inside the window only: no tag carries a quick reply past it, and an
 * automated message may not borrow `HUMAN_AGENT`.
 *
 * A title is at most 20 characters, which "Very bad" … "Great" and their
 * Arabic are well inside; cut at 20 code points all the same, so a label
 * somebody lengthens later is shortened here rather than refused by Graph.
 */

/** Meta's limit on a quick reply's title. */
const TITLE_MAX = 20;

export type RatingLabels = readonly [string, string, string, string, string];

export type QuickReply = { content_type: 'text'; title: string; payload: string };

export type QuickReplySurveyRequest = Omit<DirectMessageRequest, 'message'> & {
  message: { text: string; quick_replies: QuickReply[] };
};

const PAYLOAD = /^csat:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-5])$/;

export function quickReplyPayload(surveyId: string, rating: number): string {
  return `csat:${surveyId.toLowerCase()}:${rating}`;
}

/** The survey and rating a tapped quick reply names, or null for a payload that is not ours. */
export function readQuickReplyPayload(
  payload: unknown,
): { surveyId: string; rating: number } | null {
  if (typeof payload !== 'string') return null;
  const match = PAYLOAD.exec(payload.trim().toLowerCase());
  if (!match) return null;
  return { surveyId: match[1]!, rating: Number(match[2]) };
}

export function quickReplySurveyRequest(input: {
  platform: MetaPlatform;
  recipientId: string;
  surveyId: string;
  /** The prompt the buttons sit under: the survey's first line and question. */
  text: string;
  /** Worst first, as the page and the widget lay them out. */
  labels: RatingLabels;
}): QuickReplySurveyRequest {
  const body = directMessageRequest({
    platform: input.platform,
    recipientId: input.recipientId,
    text: input.text,
    tag: 'RESPONSE',
  });

  return {
    ...body,
    message: {
      text: body.message.text,
      quick_replies: input.labels.map((label, index) => ({
        content_type: 'text',
        title: [...label.trim()].slice(0, TITLE_MAX).join(''),
        payload: quickReplyPayload(input.surveyId, index + 1),
      })),
    },
  };
}
