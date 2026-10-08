import { env } from '@/lib/env';
import { isTimeout, sizedTimeout } from '@/lib/http/deadline';
import { mimeEssence } from '@/lib/http/mime';
import { GRAPH_BASE, graphTimeout } from '@/lib/meta/graph';
import { ACCESS_TOKEN_CODE } from './errors';
import type { WhatsAppTemplateComponent } from './templates';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

const log = logger('whatsapp');

/**
 * Meta Cloud API client.
 *
 * Deliberately `fetch` rather than the Facebook SDK: we use five endpoints, and
 * the SDK's surface (and its transitive dependencies) is not worth carrying for
 * that. Errors are normalised into `WhatsAppApiError` so the worker can decide
 * between "retry" and "this will never work".
 */

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Meta's numeric error code, which is what actually distinguishes causes. */
    readonly code: number | null,
    readonly details: string | null,
    readonly isTransient: boolean,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

/**
 * Codes worth retrying. Everything else — a bad template name, a number that is
 * not on WhatsApp, a closed 24-hour window — fails the same way on every
 * attempt, so retrying only delays the agent finding out.
 *
 *   1, 2      unknown/temporary platform error
 *   4, 80007  application or business rate limit
 *   131000    generic internal error
 *   131056    pair rate limit
 *   133016    number temporarily blocked (restore in progress)
 */
const TRANSIENT_CODES = new Set([1, 2, 4, 80007, 131000, 131016, 131056, 133016]);

/**
 * An expired or revoked token (190) is retryable too, for a different reason.
 *
 * It will not fix itself — but it is a property of the *credential*, not of the
 * request, and it stops being true the moment someone rotates the token. Every
 * other non-transient code means "this particular call is wrong and always will
 * be", which is why the handlers treat them as final: they record the reason and
 * consume the job.
 *
 * Doing that with 190 threw away work that was still perfectly good. A media
 * download would mark the message undownloadable and return, so the customer's
 * photo was gone for good even though Meta keeps media for 30 days and the
 * fetch would have succeeded on the next attempt after a rotation. A send would
 * be marked permanently failed, so an agent's reply was dropped rather than
 * delivered late.
 *
 * Retrying instead lets the job exhaust its attempts and land in 'dead', where
 * it stays inspectable and can be replayed once the token is replaced. The
 * retries themselves are cheap — five attempts against an endpoint that answers
 * 401 immediately — and the explanation in `explainAuthError` still reaches the
 * agent through the recorded delivery error.
 */
const RETRYABLE_AFTER_HUMAN_FIX = new Set([ACCESS_TOKEN_CODE]);

type MetaErrorBody = {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
};

/**
 * What a call is addressed to and authenticated with.
 *
 * Both are per-WhatsApp-Business-Account, and both are resolved by the caller —
 * from `lib/whatsapp/accounts.ts`, which reads the configured accounts — rather
 * than here. This module stays free of the database so it can be tested against
 * a fake `fetch` alone, and so a resolution that needs three queries is done
 * once per job instead of once per Graph call.
 *
 * `phoneNumberId` overrides the configured default.
 *
 * The 24-hour window belongs to a *pair* — one business number and one
 * customer — not to the business as a whole. Replying from a different number
 * than the one the customer wrote to is therefore a re-engagement message to
 * someone who never engaged, and Meta rejects it with 131047 whose text reads
 * "more than 24 hours have passed since the customer last replied **to this
 * number**". The API call itself succeeds and the rejection only arrives on a
 * later status webhook, so nothing upstream can catch it.
 *
 * Callers therefore pass the number the conversation actually arrived on, and
 * the environment default is only a fallback for sends with no inbound history.
 */
export type CallCredentials = { token?: string | null; phoneNumberId?: string | null };

/**
 * The token alone, for the calls that are not addressed to a number — media
 * lookup and download are addressed to a media id and to Meta's CDN.
 *
 * The environment fallback is the same page token Messenger and Instagram send
 * with: one Meta app serves all three products, so an account that does not
 * name its own token shares that one rather than keeping a WhatsApp copy of it
 * that has to be rotated in step.
 */
function accessToken(override?: CallCredentials | null): string {
  const token = override?.token || env().META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('META_PAGE_ACCESS_TOKEN is not configured');
  return token;
}

function credentials(override?: CallCredentials | null) {
  const resolved = override?.phoneNumberId ?? env().WHATSAPP_PHONE_NUMBER_ID;
  if (!resolved) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured');

  return { token: accessToken(override), phoneNumberId: resolved };
}

/**
 * A request that did not answer, as a transient `WhatsAppApiError`.
 *
 * Transient because a send that timed out may still arrive: the handler records
 * the sentence on the message and the queue retries. A deadline that passed
 * says so, rather than as the signal's own "The operation was aborted due to
 * timeout", which names no call.
 */
function unanswered(what: string, error: unknown, timeoutMs: number): WhatsAppApiError {
  const reason = isTimeout(error)
    ? `did not answer in ${timeoutMs / 1000}s`
    : `unreachable: ${errorMessage(error)}`;
  return new WhatsAppApiError(`${what} ${reason}`, 0, null, null, true);
}

/**
 * `fetch` with a deadline.
 *
 * A deadline because every caller is a job, and nothing else frees the worker
 * slot a request holds — and `fetch` with no signal waits five minutes for a
 * response that is not coming. The signal governs reading the body too,
 * so each caller reads it inside the same handling.
 */
async function request(
  what: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw unanswered(what, error, timeoutMs);
  }
}

/**
 * Answers null for exactly one case: a write Meta accepted whose body was lost
 * on the way back. A read, a refusal, and a 2xx whose complete body is not a
 * JSON object never answer null.
 */
async function graph<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; token: string; body?: unknown },
): Promise<T | null> {
  const method = init.method ?? 'GET';
  const timeoutMs = graphTimeout(method);
  const response = await request(
    'WhatsApp API',
    `${GRAPH_BASE}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    },
    // The deadlines Messenger and Instagram use: a send's sits inside the
    // window where giving up neither retries a message Meta was still accepting
    // nor outlasts the stalled window the heartbeat's margin is measured in.
    timeoutMs,
  );

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The status arrived and the body did not. A 2xx on a send says the message
    // went, and retrying it sends it twice; a refusal keeps its status and is
    // retried to learn the reason; a read is retried as one that did not
    // answer. The same three answers `graph()` in lib/meta/client.ts gives.
    if (response.ok && method !== 'GET') {
      log.warn(
        `${method} ${path} was accepted with ${response.status}, but its body ` +
          `never arrived: ${unanswered('WhatsApp API', error, timeoutMs).message}`,
      );
      return null;
    }
    if (!response.ok) {
      throw new WhatsAppApiError(
        `WhatsApp API refused with ${response.status}, and its reason never arrived ` +
          `(${unanswered('WhatsApp API', error, timeoutMs).message})`,
        response.status,
        null,
        null,
        true,
      );
    }
    throw unanswered('WhatsApp API', error, timeoutMs);
  }

  if (!response.ok) {
    let parsed: MetaErrorBody = {};
    try {
      parsed = JSON.parse(text) as MetaErrorBody;
    } catch {
      // Meta occasionally returns an HTML error page from the edge; keep the
      // raw text so the failure is diagnosable rather than "unexpected token".
    }

    const code = parsed.error?.code ?? null;
    const transient =
      response.status >= 500 ||
      response.status === 429 ||
      (code !== null && (TRANSIENT_CODES.has(code) || RETRYABLE_AFTER_HUMAN_FIX.has(code)));

    throw new WhatsAppApiError(
      parsed.error?.message ?? `WhatsApp API ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      code,
      parsed.error?.error_data?.details ?? null,
      transient,
    );
  }

  // Graph answers every call this client makes with a JSON object, so a 2xx
  // that is empty or is not one is not evidence Meta took anything: it is an
  // edge page, a captive portal or a proxy answering in Meta's place, which is
  // how `lib/shipments/platform.ts` reads the same evidence. So it is retried,
  // a send included. That is the opposite of the lost-body case above, and
  // deliberately: a body cut short is Meta's answer interrupted, and resending
  // it risks a duplicate; a complete body that is not Meta's answer means the
  // message probably never left, and calling it "sent" would drop the reply
  // with nothing on the row or in the queue to say so. An empty read was the
  // same trap on the other side: `{}` read as a last page with no data, and
  // template sync marked every template past the first page DELETED.
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Left undefined; refused below with the rest.
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WhatsAppApiError(
      `WhatsApp API answered ${response.status} with ` +
        (text ? `a body that is not a JSON object: ${text.slice(0, 200)}` : 'an empty body'),
      response.status,
      null,
      null,
      true,
    );
  }
  return parsed as T;
}

export type SendResult = {
  /**
   * The wamid Meta assigned. Delivery-status webhooks arrive keyed on this.
   *
   * Null when Meta accepted the send and the answer carrying the id was lost:
   * the message went, and only its receipts cannot be matched to the row.
   */
  wamid: string | null;
  /** Meta's normalised recipient number, which can differ from what we sent. */
  recipientId: string | null;
};

type SendResponse = {
  messages?: { id: string }[];
  contacts?: { input?: string; wa_id?: string }[];
};

/** Free-form text. Only valid inside the 24-hour window; Meta rejects it outside. */
export async function sendText(
  to: string,
  body: string,
  options: {
    previewUrl?: boolean;
    replyToWamid?: string | null;
  } & CallCredentials = {},
): Promise<SendResult> {
  const { token, phoneNumberId } = credentials(options);

  const response = await graph<SendResponse>(`${phoneNumberId}/messages`, {
    method: 'POST',
    token,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: options.previewUrl ?? true },
      ...(options.replyToWamid ? { context: { message_id: options.replyToWamid } } : {}),
    },
  });

  return toSendResult(response);
}

/** The only thing that sends outside the window. */
export async function sendTemplate(
  to: string,
  name: string,
  language: string,
  components: WhatsAppTemplateComponent[] = [],
  options: CallCredentials = {},
): Promise<SendResult> {
  const { token, phoneNumberId } = credentials(options);

  const response = await graph<SendResponse>(`${phoneNumberId}/messages`, {
    method: 'POST',
    token,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        ...(components.length ? { components } : {}),
      },
    },
  });

  return toSendResult(response);
}

export type MediaMetadata = {
  url: string;
  mimeType: string | null;
  sha256: string | null;
  fileSize: number | null;
};

/**
 * Resolve a media id to a download URL.
 *
 * The URL is valid for about five minutes, which is why media is downloaded by
 * a job rather than lazily when an agent opens the ticket — by then the link is
 * long dead and the file is unrecoverable.
 */
export async function getMediaUrl(
  mediaId: string,
  options: CallCredentials = {},
): Promise<MediaMetadata> {
  // Media ids are scoped to the business account that received them, so this
  // takes the token of the number the message arrived on rather than the
  // shared one, which only reaches every WABA while they are all under one
  // Meta app.
  const token = accessToken(options);
  const body = await graph<{
    url?: string;
    mime_type?: string;
    sha256?: string;
    file_size?: number;
  }>(mediaId, { token });

  if (!body?.url) throw new Error(`Meta returned no download URL for media ${mediaId}`);

  return {
    url: body.url,
    mimeType: mimeEssence(body.mime_type) || null,
    sha256: body.sha256 ?? null,
    fileSize: typeof body.file_size === 'number' ? body.file_size : null,
  };
}

/** WhatsApp's largest media: a document, at 100 MB. */
const LARGEST_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * How long one download may take, from the size Meta reported for it.
 *
 * `sizedTimeout`'s rule, which carries the reasoning; the media was lost when
 * the job died, so a flat minute cost the customer's file. A size Meta did not
 * report gets the largest file's budget, the one guess that cannot fail a real
 * file.
 *
 * The largest is 110 seconds, so the lookup and the download together leave at
 * least half of `STALLED_AFTER_MS` to the storage upload that follows, which
 * `uploadObject` bounds by the same rule — 110 seconds at the largest. Both
 * halves have to fit: the worker keeps a running job's lock fresh, but if its
 * heartbeat fails for the whole window a job still going is reclaimed and runs
 * twice, and the second run writes a second attachment row.
 */
export function mediaTimeout(sizeBytes: number | null | undefined): number {
  return sizedTimeout(sizeBytes ?? LARGEST_MEDIA_BYTES);
}

/** Meta's CDN requires the access token on the download itself, not just the lookup. */
export async function downloadMedia(
  url: string,
  options: CallCredentials & {
    /** `MediaMetadata.fileSize`, which sizes the deadline. */
    sizeBytes?: number | null;
  } = {},
): Promise<{ content: Buffer; contentType: string }> {
  const token = accessToken(options);

  const timeoutMs = mediaTimeout(options.sizeBytes);
  const response = await request(
    'Media download',
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    timeoutMs,
  );

  if (!response.ok) {
    // Nothing reads a refusal's body, and one left unread holds the connection
    // until it is collected. Released here, and its failure ignored: the
    // status is the answer.
    await response.body?.cancel().catch(() => {});
    throw new WhatsAppApiError(
      `Media download failed (${response.status})`,
      response.status,
      null,
      null,
      response.status >= 500 || response.status === 429,
    );
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw unanswered('Media download', error, timeoutMs);
  }
  return {
    content: buffer,
    contentType: mimeEssence(response.headers.get('content-type')) || 'application/octet-stream',
  };
}

export type MetaTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components?: unknown[];
};

/**
 * Lists one business account's templates, following Meta's cursor pagination.
 *
 * Takes the WABA rather than reading it from the environment: templates belong
 * to a business account, and the sync now walks every configured one.
 */
export async function listTemplates(
  account: { wabaId?: string | null; token?: string | null } = {},
): Promise<MetaTemplate[]> {
  const e = env();
  const wabaId = account.wabaId ?? e.WHATSAPP_WABA_ID;
  if (!wabaId) throw new Error('WHATSAPP_WABA_ID is not configured');

  const token = account.token || e.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('META_PAGE_ACCESS_TOKEN is not configured');

  const collected: MetaTemplate[] = [];
  let path: string | null = `${wabaId}/message_templates?limit=100`;

  // Bounded rather than `while (next)`: a paging bug on either side must not
  // turn an hourly cron into an unbounded loop against Meta's API.
  for (let page = 0; page < 20 && path; page += 1) {
    const body: { data?: MetaTemplate[]; paging?: { next?: string } } | null = await graph(path, {
      token,
    });
    collected.push(...(body?.data ?? []));

    const next: string | undefined = body?.paging?.next;
    path = next ? next.replace(`${GRAPH_BASE}/`, '') : null;
  }

  return collected;
}

function toSendResult(response: SendResponse | null): SendResult {
  // Reported as sent rather than retried into a duplicate — see `graph`.
  if (response === null) return { wamid: null, recipientId: null };

  const wamid = response.messages?.[0]?.id;
  if (!wamid) {
    // A complete JSON answer without `messages` is not a Graph acceptance, for
    // the reason `graph` gives for a body that is not JSON: retried, not
    // recorded as sent. Only the keys are named — `contacts` holds the
    // recipient's number, which has no place in a worker log.
    throw new WhatsAppApiError(
      `WhatsApp answered a send without a message id (keys: ${Object.keys(response).join(', ') || 'none'})`,
      0,
      null,
      null,
      true,
    );
  }
  return { wamid, recipientId: response.contacts?.[0]?.wa_id ?? null };
}
