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
const AVATAR_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function isStorableAvatarType(contentType: string): boolean {
  return normaliseContentType(contentType) in AVATAR_EXTENSIONS;
}

function normaliseContentType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
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
 * The extension comes from the response's content type, never from the remote
 * URL: Meta's CDN link is a query-string blob with no filename in it, and a
 * path segment taken from a URL is a path segment somebody else chose.
 */
export function buildAvatarPath(contactId: string, contentType: string): string {
  const extension = AVATAR_EXTENSIONS[normaliseContentType(contentType)] ?? 'bin';
  return `contacts/${contactId}/avatar.${extension}`;
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
