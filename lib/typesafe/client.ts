import { z } from 'zod';
import { env } from '@/lib/env';
import { isTimeout } from '@/lib/http/deadline';

/**
 * TypeSafe's System One endpoint — the first AI provider this system calls.
 *
 *     POST https://api.typesafe.ai/v1/systemone
 *
 * Jev is not a text model and this module is not a chat client. A request names
 * some `state` and a map of typed questions; the answer to a `choice` question
 * is one of the option keys the request itself offered, with a probability for
 * every option. There is no free text anywhere in the exchange, which is why the
 * categoriser built on it can be compared against a regex table at all: both
 * answer over the same fixed vocabulary, and neither can invent a category.
 *
 * Shaped after `lib/shipments/platform.ts`, which is the house template for an
 * outbound provider: the round trip owns the timeout and the error taxonomy, the
 * response is validated with zod rather than cast, and **nothing here retries**.
 * Backoff belongs to the queue (`lib/queue/index.ts`), and a dead job is the
 * visible record of a call that never succeeded; a retry loop in here would hide
 * that inside a worker slot instead.
 *
 * `@typesafe-ai/sdk` exists and is deliberately not used. It retries internally,
 * which is the one behaviour this repo puts somewhere else, and it brings its own
 * error taxonomy when the only thing a handler reads is `isTransient`.
 */

/** Where TypeSafe lives. Not configurable; `FetchOptions.baseUrl` is for tests. */
export const TYPESAFE_API_URL = 'https://api.typesafe.ai';

/**
 * The model asked for when `TYPESAFE_MODEL` says nothing.
 *
 * An alias rather than a pinned version, because the answer that matters is
 * recorded rather than assumed: every run stores the model id the *response*
 * came back with, so a shadow run stays attributable to a real version even
 * though the request named a moving target.
 */
export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';

/**
 * A classification is not a page render; it can afford to wait, but not forever.
 * The reply box's suggestion is closer to a page render and passes its own,
 * shorter `timeoutMs` (`SUGGEST_TIMEOUT_MS`).
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The ceiling TypeSafe documents for a `choice` question's option list.
 *
 * Worth naming rather than trusting: the ticket taxonomy is 55 categories today
 * and grows by hand, so the day it passes this the request stops being valid and
 * the failure should be a named assertion here rather than a 422 in a worker log.
 */
export const MAX_CHOICE_OPTIONS = 255;

export class TypeSafeApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Whether another attempt could plausibly answer differently. */
    readonly isTransient: boolean,
  ) {
    super(message);
    this.name = 'TypeSafeApiError';
  }
}

/**
 * One question, of the one primitive this system asks.
 *
 * `criteria` maps an option key to the description the model judges against. The
 * keys are ours and come back verbatim in the answer, which is what lets a
 * caller hand over `ticket_categories.key` and get one back.
 */
export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

/**
 * The request body, written down from TypeSafe's API reference.
 *
 * `state` is deliberately `unknown` rather than `string`: the endpoint accepts a
 * string, a JSON object or an array of text, and the categoriser sends an object
 * so the channel and the surrounding messages stay distinguishable from the
 * message being classified. Flattening them into one string would make the model
 * guess where the boundary was.
 */
export type SystemOneRequest = {
  state: unknown;
  model: string;
  questions: Record<string, ChoiceQuestion>;
};

/** What a caller gets back, with the transport's own fields dropped. */
export type SystemOneResponse = {
  /** The version that actually answered — `jev-1.13.0`, not the alias asked for. */
  model: string | null;
  answers: Record<string, unknown>;
  inputTokens: number | null;
};

/** One `choice` answer, already checked to be one. */
export type ChoiceAnswer = {
  choice: string;
  /** Every option's share. Absent from the payload is recorded as empty, not as zero. */
  probabilities: Record<string, number>;
  /** TypeSafe's own statistic over the distribution above. */
  confidence: number | null;
};

/**
 * Not `.strict()`, the same judgement `lib/shipments/platform.ts` makes: TypeSafe
 * is free to add fields and none of them should be able to fail a run. This says
 * what we are willing to read, not what they are allowed to send.
 */
const responseSchema = z.object({
  model: z.string().nullish(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
    })
    .nullish(),
});

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()).nullish(),
  confidence: z.number().nullish(),
});

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Whether a call can be made at all.
 *
 * For the shadow categoriser, presence of the credential is the feature flag.
 * For the reply box's suggestions it is only half of one — `suggestionsLive()`
 * in `lib/canned-suggest/settings.ts` also needs the admin switch, because
 * production holds this key for the shadow run and a key-as-flag would have
 * turned suggestions on for every agent the day they deployed.
 */
export function typesafeConfigured(): boolean {
  return Boolean(env().TYPESAFE_API_KEY);
}

/** The model this system asks for, so the request and the log agree on one value. */
export function typesafeModel(): string {
  return env().TYPESAFE_MODEL ?? DEFAULT_TYPESAFE_MODEL;
}

export type FetchOptions = {
  /** Overridden by tests and by nothing else. */
  baseUrl?: string;
  timeoutMs?: number;
};

/**
 * One request, with the error taxonomy the queue reads.
 *
 * The split between transient and permanent is the whole contract with the
 * handler above: transient means the same call could answer differently later,
 * so the row is left unwritten and the job re-runs. Permanent means it could not
 * — a wrong key, a malformed question — and a job that keeps asking only delays
 * somebody noticing.
 */
export async function systemOne(
  request: SystemOneRequest,
  options: FetchOptions = {},
): Promise<SystemOneResponse> {
  const apiKey = env().TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new TypeSafeApiError('TYPESAFE_API_KEY is not configured', null, false);
  }

  const url = `${(options.baseUrl ?? TYPESAFE_API_URL).replace(/\/+$/, '')}/v1/systemone`;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Named in seconds, as `lib/shipments/platform.ts` does: the signal's own
    // message says neither which call nor how long it waited.
    throw new TypeSafeApiError(
      isTimeout(error)
        ? `TypeSafe did not answer in ${timeoutMs / 1000}s`
        : `Could not reach TypeSafe: ${error instanceof Error ? error.message : error}`,
      null,
      true,
    );
  }

  if (!response.ok) {
    // 429 is the documented rate limit and 529 the documented overload, both of
    // which TypeSafe asks be retried with backoff. 401 and 422 are us: a wrong
    // key and a malformed question are equally wrong on the next attempt, and
    // treating either as transient would spend five job attempts proving it.
    const isTransient = response.status === 429 || response.status >= 500;
    throw new TypeSafeApiError(
      `TypeSafe returned ${response.status}${await detailOf(response)}`,
      response.status,
      isTransient,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // A deadline passing mid-body lands here too; calling it "not JSON" points
    // at a proxy when the answer was only slow.
    throw new TypeSafeApiError(
      isTimeout(error)
        ? `TypeSafe's answer did not finish arriving in ${timeoutMs / 1000}s`
        : 'TypeSafe returned a 200 that was not JSON',
      response.status,
      true,
    );
  }

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new TypeSafeApiError(
      `TypeSafe response did not parse: ${issuesOf(parsed.error)}`,
      response.status,
      false,
    );
  }

  return {
    model: parsed.data.model ?? null,
    answers: parsed.data.answers,
    inputTokens: parsed.data.usage?.input_tokens ?? null,
  };
}

/**
 * Read one named answer as a choice.
 *
 * Separate from `systemOne` because the response's `answers` map is keyed by
 * names the caller chose, and only the caller knows which primitive it asked for
 * under each. Everything here is a permanent failure: an answer of the wrong
 * type means the question was built wrongly, which no retry repairs.
 */
export function choiceAnswer(response: SystemOneResponse, name: string): ChoiceAnswer {
  const raw = response.answers[name];
  if (raw === undefined) {
    throw new TypeSafeApiError(`TypeSafe answered nothing for question "${name}"`, null, false);
  }

  const parsed = choiceAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeSafeApiError(
      `TypeSafe answer "${name}" is not a choice: ${issuesOf(parsed.error)}`,
      null,
      false,
    );
  }

  return {
    choice: parsed.data.choice,
    probabilities: parsed.data.probabilities ?? {},
    confidence: parsed.data.confidence ?? null,
  };
}

/**
 * The provider's own words about a refusal, truncated.
 *
 * Worth the extra read: a 422 from this endpoint names the question it rejected,
 * and without it the log says only that a request this system built was invalid.
 */
async function detailOf(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text ? ` — ${text.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}
