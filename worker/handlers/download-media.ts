import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { attachments, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { buildAttachmentPath, uploadObject } from '@/lib/storage';
import { downloadAttachment, MetaApiError } from '@/lib/meta/client';
import { credentialsForPhoneNumberId } from '@/lib/whatsapp/accounts';
import { WhatsAppApiError, downloadMedia, getMediaUrl } from '@/lib/whatsapp/client';

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
  const messageId = job.payload.messageId;
  if (typeof messageId !== 'string') {
    throw new Error('download_media requires a messageId');
  }

  // Facebook and Instagram hand over a URL directly; WhatsApp hands over an id
  // that has to be exchanged for one. Same job, because what happens after —
  // download, store, attach, mark — is identical, and two jobs would mean two
  // places to fix when storage changes.
  if (job.payload.source === 'meta') {
    await downloadMetaAttachment(job, messageId);
    return;
  }

  const mediaId = job.payload.mediaId;
  if (typeof mediaId !== 'string') {
    throw new Error('download_media requires a mediaId for WhatsApp media');
  }

  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, meta: messages.meta })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (!message) throw new Error(`message ${messageId} not found`);

  const meta = message.meta as { media?: Record<string, unknown>; phoneNumberId?: unknown };
  if (meta.media?.downloaded === true) {
    console.log(`[download_media] ${mediaId} already stored, skipping`);
    return;
  }

  // A media id belongs to the business account whose number received it, so the
  // token has to be that account's. The number is on the message, written by
  // the ingest — with two WABAs connected, the other account's token answers
  // this lookup with "unsupported get request", which reads like a deleted file
  // rather than the wrong credential.
  const { token } = await credentialsForPhoneNumberId(
    typeof meta.phoneNumberId === 'string' ? meta.phoneNumberId : null,
  );

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

      console.error(`[download_media] ${mediaId} unrecoverable: ${error.message}`);
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

  console.log(`[download_media] ${mediaId} → ${stored.path} (${stored.sizeBytes} bytes)`);
}

/**
 * The Facebook and Instagram half.
 *
 * Meta's CDN URLs are signed and short-lived, so this runs at high priority the
 * moment the message is ingested. A message can carry several attachments, and
 * each gets its own job keyed on its index, so one failed photo does not cost
 * the others.
 */
async function downloadMetaAttachment(job: ClaimedJob, messageId: string): Promise<void> {
  const url = job.payload.url;
  const index = typeof job.payload.index === 'number' ? job.payload.index : 0;

  if (typeof url !== 'string' || !url) {
    throw new Error('download_media requires a url for Meta attachments');
  }

  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (!message) throw new Error(`message ${messageId} not found`);

  // Already stored: the attachment row is the record, so a re-run is a no-op
  // rather than a second copy of the same photo.
  const existing = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.messageId, messageId), eq(attachments.contentId, `meta:${index}`)))
    .limit(1);

  if (existing[0]) {
    console.log(`[download_media] meta attachment ${index} of ${messageId} already stored`);
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
      console.error(`[download_media] meta attachment ${index} unrecoverable: ${error.message}`);
      return;
    }
    throw error;
  }

  const filename = `${messageId}-${index}.${EXTENSIONS[contentType] ?? 'bin'}`;
  const path = buildAttachmentPath(message.conversationId, `${messageId}-${index}`, filename);
  const stored = await uploadObject(path, content, contentType);

  await db.insert(attachments).values({
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

  console.log(`[download_media] meta ${index} → ${stored.path} (${stored.sizeBytes} bytes)`);
}
