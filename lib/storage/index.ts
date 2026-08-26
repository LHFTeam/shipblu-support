import { createHash } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * Supabase Storage via its REST API rather than the JS SDK.
 *
 * The SDK pulls in a large dependency tree for what is, for our purposes, two
 * HTTP calls. Attachments are written by the worker and read through signed
 * URLs, so nothing here runs in the request path.
 */

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

  const response = await fetch(`${url}/storage/v1/object/${bucket}/${encodeURI(path)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType || 'application/octet-stream',
      // Re-running a failed job must not 409 on the object it already wrote.
      'x-upsert': 'true',
    },
    body: new Uint8Array(content),
  });

  if (!response.ok) {
    throw new Error(`Storage upload failed (${response.status}): ${await response.text()}`);
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

  const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${encodeURI(path)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });

  if (!response.ok) {
    throw new Error(`Storage sign failed (${response.status}): ${await response.text()}`);
  }

  const body = (await response.json()) as { signedURL?: string };
  if (!body.signedURL) throw new Error('Storage sign returned no URL');

  return `${url}/storage/v1${body.signedURL}`;
}
