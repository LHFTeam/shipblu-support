import { stateFor, type MessageForState } from '@/lib/categorise-ai/request';
import { PRIORITIES, type Priority } from '@/lib/tickets/vocabulary';
import type { ChoiceQuestion, SystemOneRequest } from '@/lib/typesafe/client';

/**
 * What this system asks Jev about a message's urgency, written down in one place.
 *
 * Pure and tested for the reason `lib/categorise-ai/request.ts` gives: a `choice`
 * question with a wrong `criteria` map does not fail, it answers over the wrong
 * vocabulary, and that answer looks exactly like a right one. Here the
 * vocabulary is `PRIORITIES` itself, so a level added to the enum is a level the
 * model is offered — and `criteria` below is typed by it, so it cannot be added
 * without a description.
 *
 * The `state` is the categoriser's, built by the same `stateFor`. One shape for
 * "a customer's message and the few before it" means the two questions asked of
 * the same message are asked about the same text.
 */

/** The name this question is filed under, and the answer read back by. */
export const PRIORITY_QUESTION = 'priority';

/**
 * Each level as the model judges it, worded for this business.
 *
 * Drafted to be edited by the team that staffs against it, and written about
 * the customer's situation rather than their tone: an angry message about a
 * tracking number is still a tracking question, and a polite one about missing
 * cash-on-delivery money is not.
 *
 * `low` carries the escape hatch. It is the answer for a message too short or
 * vague to judge, exactly as `meta.unclassified` is for categories: most of this
 * archive is a 22-to-39 character fragment, and a model offered four levels and
 * no way out pushes "؟" upwards. Under-ranking here costs little, because a
 * later message on the ticket can still raise it (`decide.ts`); over-ranking
 * moves a deadline.
 */
export const PRIORITY_CRITERIA: Record<Priority, string> = {
  urgent:
    'Someone is losing money or is at risk right now: the customer threatens legal action, the police or a complaint to a regulator; reports fraud, theft or a parcel opened or tampered with; says cash-on-delivery money collected for them is missing; or threatens to go public about the company.',
  high: 'Something has clearly gone wrong and the customer is waiting on us to fix it: a delivery that is overdue or has failed more than once, a return that is stuck, a damaged or wrong item, a merchant whose shipments are blocked, or a customer who is angry about having already contacted us before.',
  medium:
    'An ordinary request about a specific parcel, order or account: where a parcel is, rescheduling a delivery, changing an address or phone number, a question about a fee or a pickup.',
  low: 'A general question not about a specific parcel, a greeting, thanks or an acknowledgement — or a message too short, vague or incomplete to tell what the customer needs.',
};

/**
 * The instruction, written out rather than assembled, for the reason the
 * categoriser's is: every clause answers something the corpus contains.
 */
const INSTRUCTIONS = [
  'This is a message a customer sent to the support team of ShipBlu, a parcel',
  'delivery company in Egypt. The sender is either a merchant who ships parcels',
  'or a recipient expecting one.',
  'How urgently does the support team need to act on it?',
  'Judge the customer’s situation, not their tone: an angry message about an',
  'ordinary request is still ordinary.',
  'Messages are usually in Egyptian Arabic, sometimes in English, and sometimes',
  'in Franco-Arabic — Arabic written in Latin letters and digits.',
  'Choose low when the message is too short, too vague or too incomplete to',
  'judge; that is a real answer, not a last resort.',
].join(' ');

export function priorityQuestion(): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  // In `PRIORITIES` order, so the request is the same bytes every time.
  for (const level of PRIORITIES) criteria[level] = PRIORITY_CRITERIA[level];
  return { type: 'choice', instructions: INSTRUCTIONS, criteria };
}

/** The whole body, so one function owns everything that goes over the wire. */
export function priorityRequest(
  message: MessageForState,
  model: string,
  withContext: boolean,
): SystemOneRequest {
  return {
    state: stateFor(message, withContext),
    model,
    questions: { [PRIORITY_QUESTION]: priorityQuestion() },
  };
}
