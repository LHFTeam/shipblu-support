import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { whatsappTemplates } from '@/db/schema';
import { env } from '@/lib/env';
import { listTemplates, WhatsAppApiError } from '@/lib/whatsapp/client';
import { explainAuthError } from '@/lib/whatsapp/errors';

/**
 * Hourly sync of the WABA's approved templates.
 *
 * Templates are edited and approved in Meta's Business Manager, not here, so
 * the console's list would otherwise drift — an agent picking a template Meta
 * has since rejected gets an opaque send failure. Upsert on (name, language)
 * because that pair, not Meta's id, is what a send actually references.
 */
export async function syncWhatsAppTemplates(): Promise<void> {
  // The cron runs hourly from the moment the Blueprint creates it, which is
  // before anyone has pasted the Meta credentials in. Skipping quietly beats
  // failing every hour: a cron that is always red is a cron nobody reads, and
  // then the first real failure goes unnoticed.
  const e = env();
  if (!e.WHATSAPP_WABA_ID || !e.WHATSAPP_ACCESS_TOKEN) {
    console.log(
      '[sync_whatsapp_templates] WhatsApp is not configured yet (WHATSAPP_WABA_ID / ' +
        'WHATSAPP_ACCESS_TOKEN) — skipping',
    );
    return;
  }

  let templates;
  try {
    templates = await listTemplates();
  } catch (error) {
    // Still fails the run — an expired credential is a real problem and a green
    // cron would hide it. What changes is that the log names the remedy instead
    // of only reporting Meta's "session has expired", which says what happened
    // but not what to do about it.
    if (error instanceof WhatsAppApiError) {
      console.error(`[sync_whatsapp_templates] ${explainAuthError(error.code, error.message)}`);
    }
    throw error;
  }

  if (templates.length === 0) {
    // Deliberately not treated as "delete everything": an API hiccup returning
    // an empty page must not wipe the templates agents are relying on.
    console.warn('[sync_whatsapp_templates] Meta returned no templates, leaving existing rows');
    return;
  }

  const now = new Date();

  for (const template of templates) {
    await db
      .insert(whatsappTemplates)
      .values({
        metaTemplateId: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
        components: template.components ?? [],
        status: template.status,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [whatsappTemplates.name, whatsappTemplates.language],
        set: {
          metaTemplateId: sql`excluded.meta_template_id`,
          category: sql`excluded.category`,
          components: sql`excluded.components`,
          status: sql`excluded.status`,
          syncedAt: now,
        },
      });
  }

  // Templates deleted in Meta stop being returned. Marking rather than deleting
  // keeps the name resolvable for messages already sent with it.
  const stale = await db
    .update(whatsappTemplates)
    .set({ status: 'DELETED' })
    .where(sql`${whatsappTemplates.syncedAt} < ${now} AND ${whatsappTemplates.status} <> 'DELETED'`)
    .returning({ id: whatsappTemplates.id });

  console.log(
    `[sync_whatsapp_templates] synced ${templates.length}` +
      (stale.length ? `, marked ${stale.length} deleted` : ''),
  );
}
