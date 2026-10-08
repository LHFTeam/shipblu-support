import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses, cannedSuggestions } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { errorMessage } from '@/lib/errors';
import { detectLocale } from '@/lib/kb/language';
import { logger } from '@/lib/log';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import { loadConversation } from '@/lib/tickets/console-guards';
import { cannedVisibleTo, listCannedResponses } from '@/lib/tickets/lookups';
import { sendsByEmail } from '@/lib/tickets/outbound';
import { TypeSafeApiError, choiceAnswer, systemOne, typesafeModel } from '@/lib/typesafe/client';
import { readHistory } from './history';
import { suggestionFrom } from './map';
import { NONE_KEY, REQUEST_VERSION, SUGGESTION_QUESTION, suggestionRequest } from './request';
import { suggestionsLive } from './settings';
import type { CannedSuggestionAnswer } from './types';

const log = logger('canned_suggest');

/**
 * Asking Jev which canned response fits a ticket, for the agent whose reply box
 * just took focus — and recording the answer either way.
 *
 * Called from a route handler rather than queued, which is the narrow exception
 * AGENTS.md's "Background work" section names: the whole output is the
 * provider's answer, somebody is looking at the box waiting for it, and it is
 * perishable — an answer that arrived after the agent started typing is worth
 * nothing, so there is nothing for a retry to rescue. Nothing here retries.
 *
 * And not a server action, because Next sends a client's actions one at a time:
 * a Jev call made as one would queue the agent's Send behind it.
 */

/**
 * How long a suggestion may take. Measured calls answer in a quarter of a
 * second (the shadow run's p90 is 274 ms); five seconds is room for a slow day
 * and still well short of the point where the agent has given up and started
 * typing, which is when the answer stops being shown at all.
 */
export const SUGGEST_TIMEOUT_MS = 5_000;

/**
 * A claimed row with no answer yet is somebody else's call still in flight —
 * another tab, another instance — until this long has passed, after which it is
 * a process that died mid-call and the row is left as an unanswered request.
 * Longer than the timeout, so a slow call is never mistaken for a dead one.
 */
const IN_FLIGHT_FOR = sql.raw(`interval '30 seconds'`);

/** How soon a composer that lost the race should ask again. */
const RETRY_AFTER_MS = 1_000;

const NOTHING: CannedSuggestionAnswer = { state: 'none' };

/**
 * The suggestion for this agent on this ticket as it stands, or null when the
 * ticket is not one this agent may open — the route answers that with a 404,
 * indistinguishable from a ticket that does not exist.
 *
 * Asks the provider at most once per agent, per ticket, per newest message: the
 * unique index on those three is both the cache and the race guard, so the agent
 * clicking in and out of the box, or two tabs on the same ticket, cost one call.
 * A new customer message — or the agent's own reply — is a new anchor and a new
 * question.
 */
export async function suggestFor(
  agent: SessionAgent,
  conversationId: string,
): Promise<CannedSuggestionAnswer | null> {
  // Off, or no key: no call and no row. Writing a row per focus would only
  // repeat a configuration fact the admin page already states.
  if (!(await suggestionsLive())) return NOTHING;

  // The id is from the browser, so the ticket is re-read with the agent's own
  // visibility — the same gate every console action passes.
  const row = await loadConversation(agent, conversationId);
  if (!row) return null;
  const { conversation } = row;
  if (readOnlyReason(conversation.channel)) return NOTHING;

  const history = await readHistory(conversationId);
  if (!history.anchorMessageId || !history.hasInbound) return NOTHING;
  const anchorMessageId = history.anchorMessageId;

  const [existing] = await db
    .select({
      id: cannedSuggestions.id,
      choice: cannedSuggestions.choice,
      cannedResponseId: cannedSuggestions.cannedResponseId,
      error: cannedSuggestions.error,
      settledAt: cannedSuggestions.settledAt,
      dismissedAt: cannedSuggestions.dismissedAt,
      repliedAt: cannedSuggestions.repliedAt,
      inFlight: sql<boolean>`${cannedSuggestions.createdAt} > now() - ${IN_FLIGHT_FOR}`,
    })
    .from(cannedSuggestions)
    .where(
      and(
        eq(cannedSuggestions.conversationId, conversationId),
        eq(cannedSuggestions.agentId, agent.id),
        eq(cannedSuggestions.anchorMessageId, anchorMessageId),
      ),
    )
    .limit(1);

  if (existing) return fromRow(existing, anchorMessageId, agent.id);

  // Exactly the composer's own list, through the rule that built it, so Jev is
  // never offered — and the third party never sent — another agent's personal
  // response or a team's this agent is not on.
  const options = await listCannedResponses(agent);
  if (options.length === 0) return NOTHING;

  const newestCustomerText = history.messages.findLast((m) => m.from === 'customer')?.text;

  // Claim before calling. `on conflict do nothing` is the race guard: a second
  // request for the same anchor finds the row and waits for it, instead of
  // paying for the same answer twice.
  const [claimed] = await db
    .insert(cannedSuggestions)
    .values({
      conversationId,
      agentId: agent.id,
      anchorMessageId,
      channel: conversation.channel,
      customerLocale: detectLocale(newestCustomerText, conversation.subject),
      requestVersion: REQUEST_VERSION,
      historyCount: history.messages.length,
      offeredIds: options.map((option) => option.id),
    })
    .onConflictDoNothing()
    .returning({ id: cannedSuggestions.id });

  if (!claimed) return { state: 'pending', retryAfterMs: RETRY_AFTER_MS };

  const startedAt = Date.now();
  try {
    const { request, keyToId } = suggestionRequest(
      history.messages,
      {
        channel: conversation.channel,
        isPublicComment: Boolean(conversation.externalId?.includes(':comment:')),
        emailSubject: sendsByEmail(conversation.channel) ? conversation.subject : null,
      },
      options,
      typesafeModel(),
    );

    const response = await systemOne(request, { timeoutMs: SUGGEST_TIMEOUT_MS });
    const suggestion = suggestionFrom(choiceAnswer(response, SUGGESTION_QUESTION), keyToId);
    const title = options.find((option) => option.id === suggestion.cannedResponseId)?.title;

    await db
      .update(cannedSuggestions)
      .set({
        settledAt: sql`now()`,
        model: response.model,
        choice: suggestion.choice,
        cannedResponseId: suggestion.cannedResponseId,
        cannedTitle: title ?? null,
        probability: suggestion.probability,
        confidence: suggestion.confidence,
        probabilities: suggestion.probabilities,
        inputTokens: response.inputTokens,
        latencyMs: Date.now() - startedAt,
      })
      .where(eq(cannedSuggestions.id, claimed.id));

    return {
      state: 'ready',
      suggestion: {
        id: claimed.id,
        cannedResponseId: suggestion.cannedResponseId,
        anchorMessageId,
      },
    };
  } catch (error) {
    // Recorded on the row, so the report has a failure rate rather than a gap.
    // A permanent failure — a wrong key, a question past the option ceiling, an
    // answer nobody offered — is wrong for every ticket and is logged as an
    // error; a slow or rate-limited provider is a warning. Either way the agent
    // just sees no suggestion, which is what they saw before this existed.
    const permanent = error instanceof TypeSafeApiError && !error.isTransient;
    if (permanent) log.error(`suggestion failed suggestion=${claimed.id}`, error);
    else log.warn(`suggestion failed suggestion=${claimed.id}`, error);

    await db
      .update(cannedSuggestions)
      .set({ settledAt: sql`now()`, error: errorMessage(error), latencyMs: Date.now() - startedAt })
      .where(eq(cannedSuggestions.id, claimed.id))
      .catch((writeError: unknown) =>
        log.error('could not record a failed suggestion', writeError),
      );

    return NOTHING;
  }
}

type ExistingRow = {
  id: string;
  choice: string | null;
  cannedResponseId: string | null;
  error: string | null;
  settledAt: Date | null;
  dismissedAt: Date | null;
  repliedAt: Date | null;
  inFlight: boolean;
};

/**
 * A stored answer, served again without asking — after a tab switch unmounted
 * the composer, a reload, or a second click into the box.
 *
 * Shown again only when it still makes sense to show: not after the agent waved
 * it away, and not when the response has since been deleted or stopped being
 * one this agent can see. In those cases the id still goes back without
 * anything to show, so the reply that follows is linked and scored all the same.
 */
async function fromRow(
  row: ExistingRow,
  anchorMessageId: string,
  agentId: string,
): Promise<CannedSuggestionAnswer> {
  if (row.error) return NOTHING;
  if (!row.settledAt) {
    return row.inFlight ? { state: 'pending', retryAfterMs: RETRY_AFTER_MS } : NOTHING;
  }
  // Already linked to a reply. The anchor moves on with that reply, so this
  // only happens to a composer that had not heard yet.
  if (row.repliedAt) return NOTHING;

  const hidden = {
    state: 'ready',
    suggestion: { id: row.id, cannedResponseId: null, anchorMessageId },
  } as const;
  if (row.choice === NONE_KEY || row.dismissedAt || !row.cannedResponseId) return hidden;

  const [visible] = await db
    .select({ id: cannedResponses.id })
    .from(cannedResponses)
    .where(and(eq(cannedResponses.id, row.cannedResponseId), cannedVisibleTo(agentId)))
    .limit(1);
  if (!visible) return hidden;

  return {
    state: 'ready',
    suggestion: { id: row.id, cannedResponseId: row.cannedResponseId, anchorMessageId },
  };
}
