import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { attachments, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { buildAttachmentPath, removeObjects, uploadObject } from '@/lib/storage';
import { downloadAttachment, MetaApiError } from '@/lib/meta/client';
import { credentialsForPhoneNumberId } from '@/lib/whatsapp/accounts';
import { WhatsAppApiError, downloadMedia, getMediaUrl } from '@/lib/whatsapp/client';
import { recordRefusalIfStored } from './stored-refusal';
import { subjectGone } from './subject-gone';
import { logger } from '@/lib/log';

const log = logger('download_media');

/**
 * Copies a WhatsApp media file into Supabase Storage.
 *
 * Meta's download URLs live about five minutes and the file is unrecoverable
 * afterwards, so this runs at high priority the moment the message is ingested
 * rather than lazily when an agent opens the ticket.
 */

/** Extensions Meta's mime types map to, for object keys and downloads. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/amr': 'amr',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};

export async function downloadMediaJob(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'download_media');
  const { messageId } = payload;

  // Facebook and Instagram hand over a URL directly; WhatsApp hands over an id
  // that has to be exchanged for one. Same job, because what happens after —
  // download, store, attach, mark — is identical, and two jobs would mean two
  // places to fix when storage changes.
  if (payload.source === 'meta') {
    await downloadMetaAttachment(messageId, payload.url, payload.index ?? 0);
    return;
  }

  const { mediaId } = payload;

  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, meta: messages.meta })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  // Checked before anything is fetched or stored: an upload for a message that
  // is already gone writes an object no row will ever name.
  const message = rows[0];
  if (!message) throw subjectGone('download_media', `message ${messageId}`);

  const meta = message.meta as { media?: Record<string, unknown>; phoneNumberId?: unknown };
  if (meta.media?.downloaded === true) {
    log.info(`${mediaId} already stored, skipping`);
    return;
  }

  // A media id belongs to the business account whose number received it, so the
  // token has to be that account's. The number is on the message, written by
  // the ingest — with two WABAs connected, the other account's token answers
  // this lookup with "unsupported get request", which reads like a deleted file
  // rather than the wrong credential.
  const phoneNumberId = typeof meta.phoneNumberId === 'string' ? meta.phoneNumberId : null;
  const credentials = await credentialsForPhoneNumberId(phoneNumberId);
  const { token } = credentials;

  let content: Buffer;
  let contentType: string;

  try {
    const metadata = await getMediaUrl(mediaId, { token });
    const downloaded = await downloadMedia(metadata.url, {
      token,
      sizeBytes: metadata.fileSize,
    });
    content = downloaded.content;
    contentType = metadata.mimeType ?? downloaded.contentType;
  } catch (error) {
    // A stored credential Meta refused is recorded on it, so the console
    // badges it before the hourly sync would (`./stored-refusal`). A 190 is
    // transient, so it is rethrown below and the file still downloads on the
    // attempt after a reconnect.
    await recordRefusalIfStored(log, mediaId, phoneNumberId, credentials, error);

    // An expired URL, a deleted file — retrying cannot bring it back, so record
    // the reason on the message and stop rather than burning five attempts.
    if (error instanceof WhatsAppApiError && !error.isTransient) {
      await db
        .update(messages)
        .set({
          meta: {
            ...(message.meta as Record<string, unknown>),
            media: { ...meta.media, downloaded: false, error: error.message },
          },
        })
        .where(eq(messages.id, messageId));

      log.error(`${mediaId} unrecoverable: ${error.message}`);
      return;
    }
    throw error;
  }

  const filename =
    (typeof meta.media?.filename === 'string' ? meta.media.filename : null) ??
    `${mediaId}.${EXTENSIONS[contentType] ?? 'bin'}`;

  const path = buildAttachmentPath(message.conversationId, `${messageId}-${mediaId}`, filename);
  const stored = await uploadObject(path, content, contentType);

  await db.transaction(async (tx) => {
    await lockMessageOrDiscard(tx, messageId, stored.path);

    await tx.insert(attachments).values({
      messageId,
      storagePath: stored.path,
      filename,
      contentType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      isInline: false,
    });

    await tx
      .update(messages)
      .set({
        meta: {
          ...(message.meta as Record<string, unknown>),
          media: { ...meta.media, downloaded: true, storagePath: stored.path },
        },
      })
      .where(eq(messages.id, messageId));
  });

  log.info(`${mediaId} → ${stored.path} (${stored.sizeBytes} bytes)`);
}

/**
 * The Facebook and Instagram half.
 *
 * Meta's CDN URLs are signed and short-lived, so this runs at high priority the
 * moment the message is ingested. A message can carry several attachments, and
 * each gets its own job keyed on its index, so one failed photo does not cost
 * the others.
 */
async function downloadMetaAttachment(
  messageId: string,
  url: string,
  index: number,
): Promise<void> {
  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (!message) throw subjectGone('download_media', `message ${messageId}`);

  // Already stored: the attachment row is the record, so a re-run is a no-op
  // rather than a second copy of the same photo.
  const existing = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.messageId, messageId), eq(attachments.contentId, `meta:${index}`)))
    .limit(1);

  if (existing[0]) {
    log.info(`meta attachment ${index} of ${messageId} already stored`);
    return;
  }

  let content: Buffer;
  let contentType: string;

  try {
    const downloaded = await downloadAttachment(url);
    content = downloaded.content;
    contentType = downloaded.contentType;
  } catch (error) {
    if (error instanceof MetaApiError && !error.isTransient) {
      log.error(`meta attachment ${index} unrecoverable: ${error.message}`);
      return;
    }
    throw error;
  }

  const filename = `${messageId}-${index}.${EXTENSIONS[contentType] ?? 'bin'}`;
  const path = buildAttachmentPath(message.conversationId, `${messageId}-${index}`, filename);
  const stored = await uploadObject(path, content, contentType);

  await db.transaction(async (tx) => {
    await lockMessageOrDiscard(tx, messageId, stored.path);

    await tx.insert(attachments).values({
      messageId,
      storagePath: stored.path,
      filename,
      contentType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      // Doubles as the idempotency key for the check above.
      contentId: `meta:${index}`,
      isInline: false,
    });
  });

  log.info(`meta ${index} → ${stored.path} (${stored.sizeBytes} bytes)`);
}

/**
 * Re-reads the message under a lock once its bytes are stored, and removes the
 * object again if the message went while they were being fetched.
 *
 * The check at the top of the job is not enough on its own. A download can take
 * seconds, and an admin purge in that window deletes the message and its
 * conversation; the attachment insert would then fail its foreign key, the job
 * would retry, and the object just uploaded would sit in the bucket with no row
 * naming it — invisible to the purge, which found its keys through those rows.
 *
 * The lock settles the race either way round. `for share` conflicts with the
 * delete a purge's cascade performs, so a purge that has not committed yet
 * waits for this transaction and then finds the attachment row, and its key,
 * like any other. A purge that already committed leaves nothing to lock, and
 * then this job is the only thing that knows the object exists.
 */
async function lockMessageOrDiscard(tx: typeof db, messageId: string, path: string): Promise<void> {
  const locked = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
    .for('share');

  if (locked[0]) return;

  const { failed } = await removeObjects([path]);
  if (failed.length > 0) {
    log.error(`${path} is orphaned: its message went mid-download`);
  }
  throw subjectGone('download_media', `message ${messageId}`);
}
