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
import type { ClaimedJob } from '@/lib/queue';
import { buildAvatarPath, isStorableAvatarType, uploadObject } from '@/lib/storage';
import { applyChannelProfile } from '@/lib/tickets/contacts';

/**
 * Puts a name and a face on a Facebook or Instagram customer.
 *
 * Messenger and Instagram webhooks carry a scoped user id and nothing else —
 * no name, no handle. WhatsApp does not have this problem because its payload
 * includes the profile name, which is why 10,198 of 10,211 WhatsApp contacts are
 * named and every single Messenger and Instagram contact was not. The User
 * Profile API is the only way to close that gap, and reading it needs Meta's
 * **Business Asset User Profile Access** feature.
 *
 * A job rather than a call inside the ingest, for three reasons that all point
 * the same way: a Graph round trip inside webhook processing makes filing a
 * ticket depend on Graph being up, it would fire once per *message* instead of
 * once per person, and a profile that cannot be read must never be able to stop
 * a customer's message from becoming a ticket. Nothing here is on the path of
 * anything the customer sees.
 */

type Payload = {
  contactId?: unknown;
  platform?: unknown;
  userId?: unknown;
  /** Re-read a profile already on file. Used by the backfill, never by ingest. */
  force?: unknown;
};

/** A profile picture is a few tens of KB. This is a guard, not a limit. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export async function fetchMetaProfile(job: ClaimedJob): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const platform = payload.platform;

  if (platform !== 'facebook' && platform !== 'instagram') {
    throw new Error('fetch_meta_profile requires a platform of "facebook" or "instagram"');
  }
  if (typeof payload.contactId !== 'string' || typeof payload.userId !== 'string') {
    throw new Error('fetch_meta_profile requires a contactId and a userId');
  }

  const contactId = payload.contactId;
  // Through the same normalisation the identity was stored under, or the lookup
  // below silently matches nothing and reads as "this contact is gone".
  const userId = normaliseIdentifier(platform, payload.userId);
  const force = payload.force === true;

  // Re-read rather than trusting the payload: a job can sit in the queue while
  // an agent names the contact by hand or a merge folds it into somebody else,
  // and the row is the only thing that knows.
  const rows = await db
    .select({
      contactId: contacts.id,
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
  if (!row) {
    // Merged away or deleted between enqueue and claim. Nothing to write to,
    // and nothing wrong either.
    console.log(`[fetch_meta_profile] ${platform} ${userId} no longer resolves to a contact`);
    return;
  }

  if (row.profileFetchedAt !== null && !force) {
    console.log(`[fetch_meta_profile] ${platform} ${userId} already looked up, skipping`);
    return;
  }

  // Not a failure worth retrying: without a page token there is no credential to
  // ask with, and that stays true until somebody sets one.
  if (!isConfigured(platform)) {
    console.warn(
      `[fetch_meta_profile] ${platform} is not configured (META_PAGE_ACCESS_TOKEN and ` +
        `${platform === 'instagram' ? 'INSTAGRAM_ACCOUNT_ID' : 'FACEBOOK_PAGE_ID'}), skipping`,
    );
    return;
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
      console.error(
        `[fetch_meta_profile] ${platform} ${userId} refused: ` +
          explainMetaProfileError(error, platform),
      );

      if (isProfilePermissionRefusal(error)) {
        console.error(
          `[fetch_meta_profile] this is the refusal that means the Meta app may not hold ` +
            `Business Asset User Profile Access — check App Review before treating it as a ` +
            `property of this one customer`,
        );
      }
      return;
    }
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
    // The name is written either way — it is the part that makes a ticket
    // readable — but a picture we could not fetch this time leaves the identity
    // open, so the next message asks again.
    markFetched: !avatar.retryable,
  });

  if (avatar.retryable) {
    // Thrown after the write, so the name is already durable and the retry is
    // only about the picture. Exhausting the attempts leaves a dead row that
    // says so, which is better than a contact silently left faceless.
    throw new Error(
      `[fetch_meta_profile] ${platform} ${userId}: name saved, but the profile picture ` +
        `could not be fetched — retrying`,
    );
  }

  console.log(
    `[fetch_meta_profile] ${platform} ${userId} → ` +
      `${profile.name ?? profile.username ?? '(no name)'}` +
      `${avatar.path ? ' with picture' : ''}`,
  );
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
        `[fetch_meta_profile] ${contactId} avatar is over ${MAX_AVATAR_BYTES} bytes, not stored`,
      );
      return { path: existingPath, retryable: false };
    }

    console.warn(
      `[fetch_meta_profile] ${contactId} avatar download failed, keeping the name: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    // Keeps whatever was already on file rather than blanking a working picture
    // because one refresh could not reach the CDN.
    return { path: existingPath, retryable: true };
  }

  if (!isStorableAvatarType(contentType)) {
    console.warn(`[fetch_meta_profile] ${contactId} avatar is ${contentType}, not stored`);
    return { path: existingPath, retryable: false };
  }

  try {
    const stored = await uploadObject(buildAvatarPath(contactId), content, contentType);
    return { path: stored.path, retryable: false };
  } catch (error) {
    // Our own storage being unavailable is the most retryable failure here.
    console.warn(
      `[fetch_meta_profile] ${contactId} avatar upload failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return { path: existingPath, retryable: true };
  }
}
