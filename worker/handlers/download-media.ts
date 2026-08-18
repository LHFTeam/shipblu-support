import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { attachments, messages } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { buildAttachmentPath, uploadObject } from '@/lib/storage';
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
  const mediaId = job.payload.mediaId;

  if (typeof messageId !== 'string' || typeof mediaId !== 'string') {
    throw new Error('download_media requires messageId and mediaId');
  }

  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, meta: messages.meta })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (!message) throw new Error(`message ${messageId} not found`);

  const meta = message.meta as { media?: Record<string, unknown> };
  if (meta.media?.downloaded === true) {
    console.log(`[download_media] ${mediaId} already stored, skipping`);
    return;
  }

  let content: Buffer;
  let contentType: string;

  try {
    const metadata = await getMediaUrl(mediaId);
    const downloaded = await downloadMedia(metadata.url);
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
