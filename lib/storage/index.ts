import { createHash } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Supabase Storage via its REST API rather than the JS SDK.
 *
 * The SDK pulls in a large dependency tree for what is, for our purposes, two
 * HTTP calls. Attachments are written mostly by the worker and read through
 * signed URLs — but a customer's form upload writes from inside their request,
 * and every signed URL is minted inside an agent's, so both calls carry a
 * deadline. In a job the deadline matters more: the worker awaits a whole batch
 * before it claims another, and `fetch` with no signal waits five minutes for a
 * response that is not coming, so one slow request held every queued job.
 */

/**
 * How long an upload of this many bytes may take.
 *
 * A minute for anything, and a second more for every 2 MB — the slowest link
 * this accepts, a choice rather than a measurement. The largest object we write
 * is a WhatsApp document at 100 MB, not a form's 25 MB, and a flat minute gave
 * it up below 1.7 MB/s on every attempt alike. That matters most where nothing
 * retries: email ingest drops an attachment whose upload failed, so a slow but
 * working upload cut short is a file the customer sent and the agent never
 * sees. Scaled rather than simply raised, because a small file that stalls
 * should still be noticed in a minute. 110 seconds at the largest.
 */
function uploadTimeout(bytes: number): number {
  return 60_000 + Math.ceil(bytes / (2 * 1024 * 1024)) * 1000;
}
/** Signing is one small round trip, and somebody is waiting on the page. */
const SIGN_TIMEOUT_MS = 10_000;

/** The error for a deadline that passed, naming the object rather than the signal. */
function unanswered(what: string, error: unknown, timeoutMs: number): unknown {
  return error instanceof DOMException && error.name === 'TimeoutError'
    ? new Error(`Storage ${what} did not answer in ${timeoutMs / 1000}s`)
    : error;
}

/** `fetch` with a deadline, and a message that names the object when it passes. */
async function storageRequest(
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
 * The body a storage request answered with, read under the same deadline.
 *
 * The signal governs the read as well as the status, and a deadline passing
 * mid-body rejects with the signal's own reason, which names no object.
 */
async function readBody(what: string, response: Response, timeoutMs: number): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw unanswered(what, error, timeoutMs);
  }
}

export type StoredObject = {
  path: string;
  checksum: string;
  sizeBytes: number;
};

function config() {
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to store attachments');
  }
  return {
    url: e.SUPABASE_URL.replace(/\/$/, ''),
    key: e.SUPABASE_SERVICE_ROLE_KEY,
    bucket: e.SUPABASE_STORAGE_BUCKET,
  };
}

/**
 * Filenames come from email attachments and are fully attacker-controlled, so
 * the stored path is derived from ids we generate. The original name is kept in
 * the database column for display only, never used as a path segment.
 */
export function buildAttachmentPath(
  conversationId: string,
  messageId: string,
  filename: string,
): string {
  const extension = /\.([a-zA-Z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase() ?? 'bin';
  return `conversations/${conversationId}/${messageId}.${extension}`;
}

/** Image types a channel's profile picture is allowed to be stored as. */
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function isStorableAvatarType(contentType: string): boolean {
  return AVATAR_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase());
}

/**
 * One object per contact, overwritten in place.
 *
 * A stable key rather than a new object per fetch, because the alternative
 * accumulates a copy of every profile picture a customer has ever had and
 * nothing ever deletes them — `contacts.avatar_path` only remembers the newest,
 * so the older ones would be unreferenced bytes we keep paying for. `x-upsert`
 * on the upload is what makes overwriting work.
 *
 * **No extension**, which is what actually makes the key stable. Deriving one
 * from the content type looks tidier and quietly breaks the invariant above:
 * Meta's CDN re-encodes, so the same customer's picture arriving as WebP after
 * it was JPEG writes a second object and strands the first — the exact leak the
 * stable key exists to avoid, once per format. Storage keeps the Content-Type it
 * was uploaded with and serves it back, so the extension was never load-bearing;
 * `isStorableAvatarType` is what decides whether the bytes are an image at all.
 */
export function buildAvatarPath(contactId: string): string {
  return `contacts/${contactId}/avatar`;
}

export async function uploadObject(
  path: string,
  content: Buffer,
  contentType: string,
): Promise<StoredObject> {
  const { url, key, bucket } = config();

  // Safe to retry after a timeout: `x-upsert` makes a second attempt overwrite
  // whatever the first managed to write. Not every caller retries, which is
  // why the deadline is sized from the file rather than guessed.
  const timeoutMs = uploadTimeout(content.length);
  const response = await storageRequest(
    `upload of ${path}`,
    `${url}/storage/v1/object/${bucket}/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': contentType || 'application/octet-stream',
        // Re-running a failed job must not 409 on the object it already wrote.
        'x-upsert': 'true',
      },
      body: new Uint8Array(content),
    },
    timeoutMs,
  );

  // The success body is never read: a 2xx is the object stored, and waiting on
  // the rest of the answer could only turn a stored file into a failure.
  if (!response.ok) {
    throw new Error(
      `Storage upload failed (${response.status}): ` +
        (await readBody(`upload of ${path}`, response, timeoutMs)),
    );
  }

  return {
    path,
    checksum: createHash('sha256').update(content).digest('hex'),
    sizeBytes: content.length,
  };
}

/**
 * Short-lived signed URL. Attachments are never public: a ticket attachment can
 * be an invoice or an ID document, so the bucket stays private and the console
 * mints a URL per view.
 */
export async function signedUrl(path: string, expiresInSeconds = 300): Promise<string> {
  const { url, key, bucket } = config();

  const response = await storageRequest(
    `sign of ${path}`,
    `${url}/storage/v1/object/sign/${bucket}/${encodeURI(path)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    },
    SIGN_TIMEOUT_MS,
  );

  const text = await readBody(`sign of ${path}`, response, SIGN_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`Storage sign failed (${response.status}): ${text}`);
  }

  const body = JSON.parse(text) as { signedURL?: string };
  if (!body.signedURL) throw new Error('Storage sign returned no URL');

  return `${url}/storage/v1${body.signedURL}`;
}
