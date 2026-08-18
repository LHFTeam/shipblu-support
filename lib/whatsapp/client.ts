import { env } from '@/lib/env';
import type { WhatsAppTemplateComponent } from './templates';

/**
 * Meta Cloud API client.
 *
 * Deliberately `fetch` rather than the Facebook SDK: we use five endpoints, and
 * the SDK's surface (and its transitive dependencies) is not worth carrying for
 * that. Errors are normalised into `WhatsAppApiError` so the worker can decide
 * between "retry" and "this will never work".
 */

const GRAPH_VERSION = 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

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

type MetaErrorBody = {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
};

function credentials() {
  const e = env();
  if (!e.WHATSAPP_ACCESS_TOKEN) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');
  if (!e.WHATSAPP_PHONE_NUMBER_ID) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not configured');
  return { token: e.WHATSAPP_ACCESS_TOKEN, phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID };
}

async function graph<T>(
  path: string,
  init: { method?: string; token: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${GRAPH_BASE}/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${init.token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  const text = await response.text();

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
      (code !== null && TRANSIENT_CODES.has(code));

    throw new WhatsAppApiError(
      parsed.error?.message ?? `WhatsApp API ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      code,
      parsed.error?.error_data?.details ?? null,
      transient,
    );
  }

  return (text ? JSON.parse(text) : {}) as T;
}

export type SendResult = {
  /** The wamid Meta assigned. Delivery-status webhooks arrive keyed on this. */
  wamid: string;
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
  options: { previewUrl?: boolean; replyToWamid?: string | null } = {},
): Promise<SendResult> {
  const { token, phoneNumberId } = credentials();

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
): Promise<SendResult> {
  const { token, phoneNumberId } = credentials();

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

/**
 * Marks the customer's message read, so the console's read receipts match what
 * the customer sees in WhatsApp. Best-effort: failing to tick a message blue is
 * never worth failing a job over.
 */
export async function markRead(wamid: string): Promise<void> {
  const { token, phoneNumberId } = credentials();
  await graph(`${phoneNumberId}/messages`, {
    method: 'POST',
    token,
    body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
  });
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
export async function getMediaUrl(mediaId: string): Promise<MediaMetadata> {
  const { token } = credentials();
  const body = await graph<{
    url?: string;
    mime_type?: string;
    sha256?: string;
    file_size?: number;
  }>(mediaId, { token });

  if (!body.url) throw new Error(`Meta returned no download URL for media ${mediaId}`);

  return {
    url: body.url,
    mimeType: body.mime_type?.split(';')[0]?.trim() ?? null,
    sha256: body.sha256 ?? null,
    fileSize: typeof body.file_size === 'number' ? body.file_size : null,
  };
}

/** Meta's CDN requires the access token on the download itself, not just the lookup. */
export async function downloadMedia(
  url: string,
): Promise<{ content: Buffer; contentType: string }> {
  const { token } = credentials();

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!response.ok) {
    throw new WhatsAppApiError(
      `Media download failed (${response.status})`,
      response.status,
      null,
      null,
      response.status >= 500 || response.status === 429,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    content: buffer,
    contentType:
      response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream',
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

/** Lists the WABA's templates, following Meta's cursor pagination. */
export async function listTemplates(): Promise<MetaTemplate[]> {
  const e = env();
  if (!e.WHATSAPP_WABA_ID) throw new Error('WHATSAPP_WABA_ID is not configured');
  if (!e.WHATSAPP_ACCESS_TOKEN) throw new Error('WHATSAPP_ACCESS_TOKEN is not configured');

  const token = e.WHATSAPP_ACCESS_TOKEN;
  const collected: MetaTemplate[] = [];
  let path: string | null = `${e.WHATSAPP_WABA_ID}/message_templates?limit=100`;

  // Bounded rather than `while (next)`: a paging bug on either side must not
  // turn an hourly cron into an unbounded loop against Meta's API.
  for (let page = 0; page < 20 && path; page += 1) {
    const body: { data?: MetaTemplate[]; paging?: { next?: string } } = await graph(path, {
      token,
    });
    collected.push(...(body.data ?? []));

    const next = body.paging?.next;
    path = next ? next.replace(`${GRAPH_BASE}/`, '') : null;
  }

  return collected;
}

function toSendResult(response: SendResponse): SendResult {
  const wamid = response.messages?.[0]?.id;
  if (!wamid) throw new Error('WhatsApp send returned no message id');
  return { wamid, recipientId: response.contacts?.[0]?.wa_id ?? null };
}
