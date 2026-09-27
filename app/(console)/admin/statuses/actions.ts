'use server';

import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketStatuses, conversations } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { int, text, uuidField } from '@/lib/http/form-data';
import { isStatusCategory } from '@/lib/tickets/vocabulary';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Ticket statuses --------------------------------------------------------

export async function saveStatus(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const category = text(formData, 'category');
  const stopsSlaClock = formData.get('stopsSlaClock') === 'on';
  const visibleToCustomer = formData.get('visibleToCustomer') === 'on';
  const customerLabel = text(formData, 'customerLabel') || null;
  const position = int(formData, 'position');
  const isDefault = formData.get('isDefault') === 'on';

  if (!name) return { error: 'Give the status a name' };
  if (!isStatusCategory(category)) {
    return { error: 'Pick a category' };
  }

  const values = {
    name,
    category,
    stopsSlaClock,
    visibleToCustomer,
    customerLabel,
    position,
    isDefault,
  };

  await db.transaction(async (tx) => {
    // Exactly one default per category, or ingest picks arbitrarily between them.
    if (isDefault) {
      await tx
        .update(ticketStatuses)
        .set({ isDefault: false })
        .where(
          and(
            eq(ticketStatuses.category, values.category),
            id ? ne(ticketStatuses.id, id) : sql`true`,
          ),
        );
    }

    if (id) {
      await tx.update(ticketStatuses).set(values).where(eq(ticketStatuses.id, id));
    } else {
      await tx.insert(ticketStatuses).values(values);
    }
  });

  refresh('/admin/statuses');
  return ok();
}

export async function deleteStatus(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const rows = await db
    .select({ isSystem: ticketStatuses.isSystem })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.id, id))
    .limit(1);

  if (rows[0]?.isSystem) return { error: 'That status is built in and cannot be deleted' };

  const inUse = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.statusId, id));

  if ((inUse[0]?.count ?? 0) > 0) {
    return { error: `That status is on ${inUse[0]!.count} ticket(s). Move them first.` };
  }

  await db.delete(ticketStatuses).where(eq(ticketStatuses.id, id));
  refresh('/admin/statuses');
  return ok();
}
