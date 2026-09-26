import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, contacts } from '@/db/schema';
import { normaliseIdentifier } from '@/lib/auth/normalise';
import {
  downloadAttachment,
  fetchProfile,
  isConfigured,
  MetaApiError,
  MetaContentTooLargeError,
} from '@/lib/meta/client';
import { explainMetaProfileError, isProfilePermissionRefusal } from '@/lib/meta/errors';
import { normaliseGender } from '@/lib/meta/profile';
import type { MetaPlatform } from '@/lib/meta/types';
import { buildAvatarPath, isStorableAvatarType, uploadObject } from '@/lib/storage';
import { applyChannelProfile } from '@/lib/tickets/contacts';
import { errorMessage } from '@/lib/errors';

/**
 * Putting a name and a face on a Facebook or Instagram customer.
 *
 * One implementation, three callers: the job enqueued when somebody writes in
 * for the first time, the archive backfill, and the console's manual retry
 * button. They had every reason to drift apart — the first two want a queue's
 * retries and the third wants an answer while an agent watches — and a refresh
 * that produced a different answer depending on who asked for it is a
 * discrepancy nobody would ever explain. `backfill_meta_profiles` makes the same
 * argument for enqueueing rather than calling Graph itself.
 *
 * So the decisions live here and the *reaction* lives with the caller: this
 * returns what happened and throws only when the caller could not have known.
 * A job turns `transient` into a rethrow so the queue retries it; an action
 * turns it into a sentence under the button. Neither can accidentally stamp an
 * identity the other would have left alone.
 */

/** A profile picture is a few tens of KB. This is a guard, not a limit. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export type ProfileRefreshResult =
  /** Merged away or deleted between the ask and the attempt. Nothing is wrong. */
  | { kind: 'gone' }
  /** Already answered for, and the caller did not ask to re-read it. */
  | { kind: 'skipped' }
  /** No credential to ask with, which stays true until somebody sets one. */
  | { kind: 'unconfigured'; detail: string }
  /** Graph said no, and will say no again. Never stamped — see below. */
  | { kind: 'refused'; reason: string; permission: boolean }
  /** Worth another attempt: the caller decides whether there will be one. */
  | { kind: 'transient'; error: MetaApiError }
  | {
      kind: 'applied';
      name: string | null;
      /** `retry` means Meta holds a picture we failed to copy this time. */
      picture: 'stored' | 'none' | 'retry';
      /** The channel's own locale code, when it gave one. */
      locale: string | null;
      /** Whether a gender came back — never which, see the caller's log line. */
      gender: boolean;
      /**
       * Graph refused `locale` and `gender` specifically, and answered the
       * narrower request. Separates "not approved for those two" from "this
       * person set neither", which look identical in the columns.
       */
      extendedFieldsRefused: boolean;
    };

export async function refreshChannelProfile(input: {
  contactId: string;
  platform: MetaPlatform;
  /** Normalised here, so no caller can pass the raw webhook form by mistake. */
  userId: string;
  /** Re-read a profile already on file. The backfill and the button set it. */
  force?: boolean;
}): Promise<ProfileRefreshResult> {
  const { contactId, platform } = input;
  // Through the same normalisation the identity was stored under, or the lookup
  // below silently matches nothing and reads as "this contact is gone".
  const userId = normaliseIdentifier(platform, input.userId);

  // Re-read rather than trusting the caller: a job can sit in the queue while an
  // agent names the contact by hand or a merge folds it into somebody else, and
  // the row is the only thing that knows.
  const rows = await db
    .select({
      name: contacts.name,
      avatarPath: contacts.avatarPath,
      profileFetchedAt: contactIdentities.profileFetchedAt,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(
      and(
        eq(contactIdentities.channel, platform),
        eq(contactIdentities.identifier, userId),
        eq(contactIdentities.contactId, contactId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { kind: 'gone' };
  if (row.profileFetchedAt !== null && input.force !== true) return { kind: 'skipped' };

  if (!isConfigured(platform)) {
    return {
      kind: 'unconfigured',
      detail: `META_PAGE_ACCESS_TOKEN and ${
        platform === 'instagram' ? 'INSTAGRAM_ACCOUNT_ID' : 'FACEBOOK_PAGE_ID'
      }`,
    };
  }

  let profile: Awaited<ReturnType<typeof fetchProfile>>;
  try {
    profile = await fetchProfile(platform, userId);
  } catch (error) {
    if (error instanceof MetaApiError && !error.isTransient) {
      /*
        Consumed rather than retried, and deliberately *without* stamping
        `profile_fetched_at`.

        Stamping it would record "we asked and got nothing", which is true today
        and wrong the moment the feature is approved — every customer already in
        the archive would stay anonymous forever because nothing would ever ask
        again. Leaving it null costs one doomed Graph call per person per new
        message while the app is unapproved, and turns approval into something
        that fixes itself.
      */
      return {
        kind: 'refused',
        reason: explainMetaProfileError(error, platform),
        permission: isProfilePermissionRefusal(error),
      };
    }
    if (error instanceof MetaApiError) return { kind: 'transient', error };
    throw error;
  }

  const avatar = await storeAvatar(contactId, profile.pictureUrl, row.avatarPath);

  await applyChannelProfile({
    contactId,
    channel: platform,
    identifier: userId,
    // Instagram's handle is what an agent would recognise; Messenger has no
    // equivalent, so `name` is all there is.
    name: profile.name ?? profile.username,
    avatarPath: avatar.path,
    /*
      Kept on the *identity* and deliberately not copied into `contacts.locale`.

      That column is not a record of what a channel reported, it is the answer
      to "which language do we address this person in", and everything reading
      it treats 'ar' as a settled preference: `preferredLocale` returns 'ar'
      without so much as looking at what the customer wrote, and `send_csat`
      and the customer portal branch on it the same way. A Facebook *interface*
      language is not that. Writing it through would mean one Messenger message
      from a merchant whose Facebook is set to Arabic silently switches their
      out-of-hours email auto-reply and their CSAT survey to Arabic — on every
      channel, including ones where they have only ever written English.

      Reading the language off the message body, which is what happens today,
      is both better evidence and reversible.
    */
    profileLocale: profile.locale,
    gender: normaliseGender(profile.gender),
    // The name is written either way — it is the part that makes a ticket
    // readable — but a picture we could not fetch this time leaves the identity
    // open, so the next message asks again.
    markFetched: !avatar.retryable,
  });

  return {
    kind: 'applied',
    name: profile.name ?? profile.username ?? null,
    picture: avatar.retryable ? 'retry' : avatar.path ? 'stored' : 'none',
    locale: profile.locale,
    gender: normaliseGender(profile.gender) !== null,
    extendedFieldsRefused: profile.extendedFieldsRefused,
  };
}

type StoredAvatar = {
  path: string | null;
  /** The picture exists and we simply failed to get it. Ask again. */
  retryable: boolean;
};

/**
 * Copies the profile picture into our own bucket.
 *
 * Never stores Meta's URL. `profile_pic` is a signed CDN link that expires, so
 * a stored URL is an avatar that works during the demo and is a broken image a
 * week later — the same reasoning that makes `download_media` copy attachments
 * on arrival rather than lazily.
 *
 * The return distinguishes the two ways there can be no picture, because they
 * need opposite follow-ups. A profile that simply has none, or one whose image
 * we will never accept — the wrong format, too large — is *finished*: asking
 * again produces the same answer forever. A download that failed is not, and
 * treating it as though it were is what would leave a contact permanently
 * faceless while Meta holds a picture for them, invisible to the backfill
 * because the identity had been stamped as answered.
 */
async function storeAvatar(
  contactId: string,
  pictureUrl: string | null,
  existingPath: string | null,
): Promise<StoredAvatar> {
  if (!pictureUrl) return { path: null, retryable: false };

  let content: Buffer;
  let contentType: string;

  try {
    ({ content, contentType } = await downloadAttachment(pictureUrl, {
      maxBytes: MAX_AVATAR_BYTES,
    }));
  } catch (error) {
    if (error instanceof MetaContentTooLargeError) {
      console.warn(
        `[profile_refresh] ${contactId} avatar is over ${MAX_AVATAR_BYTES} bytes, not stored`,
      );
      return { path: existingPath, retryable: false };
    }

    console.warn(
      `[profile_refresh] ${contactId} avatar download failed, keeping the name: ` +
        `${errorMessage(error)}`,
    );
    // Keeps whatever was already on file rather than blanking a working picture
    // because one refresh could not reach the CDN.
    return { path: existingPath, retryable: true };
  }

  if (!isStorableAvatarType(contentType)) {
    console.warn(`[profile_refresh] ${contactId} avatar is ${contentType}, not stored`);
    return { path: existingPath, retryable: false };
  }

  try {
    const stored = await uploadObject(buildAvatarPath(contactId), content, contentType);
    return { path: stored.path, retryable: false };
  } catch (error) {
    // Our own storage being unavailable is the most retryable failure here.
    console.warn(
      `[profile_refresh] ${contactId} avatar upload failed: ` + `${errorMessage(error)}`,
    );
    return { path: existingPath, retryable: true };
  }
}

/**
 * The outcome as one line for an agent, rather than for a log.
 *
 * Meta's own sentence is kept whole for a refusal, because it is the half that
 * is actually diagnostic — "the app is not approved for this" and "this person
 * is gone" arrive as different text and an agent handing the message to whoever
 * holds the Meta dashboard needs the difference intact.
 */
export function describeProfileRefresh(result: ProfileRefreshResult): string {
  switch (result.kind) {
    case 'gone':
      return 'That contact no longer exists — it may have been merged into another.';
    case 'skipped':
      return 'This profile has already been looked up.';
    case 'unconfigured':
      return `This channel has no credential configured (${result.detail}).`;
    case 'refused':
      return result.reason;
    case 'transient':
      return `Meta could not answer just now: ${result.error.message}. Try again in a moment.`;
    case 'applied': {
      if (!result.name && result.picture === 'none') {
        return 'Meta answered, but this customer has no name or picture to share.';
      }
      const who = result.name ? `Got ${result.name}` : 'Got a profile picture';
      if (result.picture === 'retry') {
        return `${who}. The picture could not be copied this time — try again for it.`;
      }
      return result.picture === 'stored' ? `${who}, with their picture.` : `${who}.`;
    }
  }
}
