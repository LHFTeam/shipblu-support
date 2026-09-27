'use server';

import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { autoResponses, groups } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { refresh, type SettingsState } from '../settings-shared';

// --- Out-of-hours auto-responses --------------------------------------------

/**
 * The channel values a rule may be scoped to.
 *
 * Read from the form and checked against this list rather than cast, because
 * the column is an enum: an unknown value is a Postgres error at write time,
 * and the error a customer-facing setting deserves is "pick a channel", not a
 * 500 in the log.
 *
 * `whatsapp_bot` is deliberately absent. Nothing is ever sent on it — the bot
 * owns those conversations — so offering it would be offering a setting that
 * cannot do anything.
 */
const AUTO_RESPONSE_CHANNELS = [
  'email',
  'whatsapp',
  'webchat',
  'facebook',
  'instagram',
  'portal',
] as const;

type AutoResponseChannel = (typeof AUTO_RESPONSE_CHANNELS)[number];

function autoResponseChannel(formData: FormData): AutoResponseChannel | null | undefined {
  const raw = text(formData, 'channel');
  if (!raw) return null;
  return (AUTO_RESPONSE_CHANNELS as readonly string[]).includes(raw)
    ? (raw as AutoResponseChannel)
    : undefined;
}

export async function saveAutoResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');

  const id = uuidField(formData, 'id');
  const groupId = uuidField(formData, 'groupId');
  if (id === undefined || groupId === undefined) {
    return { error: 'That form is out of date — reload the page and try again' };
  }

  const channel = autoResponseChannel(formData);
  if (channel === undefined) return { error: 'Pick a channel, or leave it on every channel' };

  // Re-read rather than trusted, the way `saveChannel` re-reads the business
  // account it is handed: the id arrives in a FormData field, and a group
  // deleted in another tab reaches the insert as a foreign key violation — a
  // thrown action, which returns no state, rather than the sentence this form
  // is built to show.
  if (groupId) {
    const group = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);

    if (!group[0]) return { error: 'That group no longer exists' };
  }

  const silent = formData.get('silent') === 'on';
  const bodyAr = text(formData, 'bodyAr');
  const bodyEn = text(formData, 'bodyEn');

  // A rule that is neither silent nor written sends nothing, which is the same
  // as not existing — except that it also shadows the broader rule that would
  // have answered. Better refused at the form than debugged at midnight.
  if (!silent && !bodyAr && !bodyEn) {
    return { error: 'Write the message in at least one language, or tick “send nothing”' };
  }

  const values = {
    groupId,
    channel,
    silent,
    isActive: formData.get('isActive') === 'on',
    updatedAt: new Date(),
    /*
      The four bodies only when they were on screen to be edited.

      Ticking "send nothing" unmounts all four textareas, so they do not reach
      us at all and `text()` reads every one of them as ''. Writing those is how
      muting a rule for a week silently destroyed the Arabic, English and two
      holiday messages behind it — and un-ticking the box afterwards gave the
      admin four blank boxes with nothing to undo from. The guard above cannot
      catch it either: it is skipped in exactly the case that does the damage.
    */
    ...(silent
      ? {}
      : {
          bodyAr,
          bodyEn,
          holidayBodyAr: text(formData, 'holidayBodyAr'),
          holidayBodyEn: text(formData, 'holidayBodyEn'),
        }),
  };

  // The scope is the identity, so a duplicate is a constraint violation rather
  // than a second row: caught here to say which rule already covers it, because
  // the raw error names a constraint the admin has never heard of.
  const clash = await db
    .select({ id: autoResponses.id })
    .from(autoResponses)
    .where(
      and(
        groupId ? eq(autoResponses.groupId, groupId) : isNull(autoResponses.groupId),
        channel ? eq(autoResponses.channel, channel) : isNull(autoResponses.channel),
        id ? ne(autoResponses.id, id) : undefined,
      ),
    )
    .limit(1);

  if (clash[0]) {
    return { error: 'A rule already covers that group and channel — edit it instead' };
  }

  if (id) {
    await db.update(autoResponses).set(values).where(eq(autoResponses.id, id));
  } else {
    await db.insert(autoResponses).values(values);
  }

  refresh('/admin/auto-responses');
  return ok();
}

export async function deleteAutoResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };
  await db.delete(autoResponses).where(eq(autoResponses.id, id));
  refresh('/admin/auto-responses');
  return ok();
}
