import { db } from '@/db/client';
import { attachments } from '@/db/schema';
import { buildAttachmentPath, uploadObject } from '@/lib/storage';
import { mimeEssence } from '@/lib/http/mime';
import { logger } from '@/lib/log';

const log = logger('forms');

/**
 * Uploads the files and files them against the ticket's first message.
 *
 * Runs **after** the transaction commits, which means a storage failure loses
 * the file and not the ticket. That is the right way round, and it must not be
 * silent — the caller writes a note naming what did not arrive, so the agent
 * asks for it again rather than never learning it was sent.
 *
 * The `-index` in the path is not decoration: `buildAttachmentPath` keys on one
 * id, so two files on one message would otherwise write the same object and the
 * second would overwrite the first. `worker/handlers/download-media.ts` already
 * disambiguates the same way.
 */
export async function storeFormAttachments(input: {
  conversationId: string;
  messageId: string;
  files: File[];
}): Promise<{ stored: number; failed: string[] }> {
  const failed: string[] = [];
  let stored = 0;

  for (const [index, file] of input.files.entries()) {
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      const contentType = mimeEssence(file.type) || 'application/octet-stream';

      const object = await uploadObject(
        buildAttachmentPath(input.conversationId, `${input.messageId}-${index}`, file.name),
        bytes,
        contentType,
      );

      await db.insert(attachments).values({
        messageId: input.messageId,
        storagePath: object.path,
        // The name is display only and never a path segment — the stored key is
        // derived from ids we generate, because a filename is fully
        // attacker-controlled.
        filename: file.name.slice(0, 255),
        contentType,
        sizeBytes: object.sizeBytes,
        checksum: object.checksum,
      });

      stored += 1;
    } catch (error) {
      log.error(`could not store ${file.name} on ${input.conversationId}`, error);
      failed.push(file.name);
    }
  }

  return { stored, failed };
}
