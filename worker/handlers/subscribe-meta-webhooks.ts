import { configuredAccountId } from '@/lib/meta/client';
import {
  applyFieldSubscription,
  applyPageSubscription,
  INSTAGRAM_OBJECT,
  PAGE_OBJECT,
  planFieldSubscription,
  planPageSubscription,
  readPageSubscription,
  readSubscription,
  REQUIRED_FIELDS,
  resolveObject,
} from '@/lib/meta/subscriptions';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Bring one webhook object's field subscription up to what the pipeline needs.
 *
 * Run by hand rather than on a schedule, one object at a time:
 *
 *   npm run job -- subscribe_meta_webhooks                     # WhatsApp
 *   npm run job -- subscribe_meta_webhooks object=instagram    # adds `comments`
 *   npm run job -- subscribe_meta_webhooks object=page         # adds `feed`
 *
 * It is here as a job rather than as a pasted curl command for one reason: the
 * Graph call that adds a field replaces the whole field list, so doing it by
 * hand means typing out every field that must survive, and getting that wrong
 * unsubscribes `messages` and stops a channel dead. Reading first and merging is
 * the entire point, and it is not something to improvise at a shell prompt
 * against production.
 *
 * **`object=page` and `object=instagram` each do two writes, because both have
 * two subscriptions.** Meta only delivers a field subscribed at *both* the app level
 * and the Page level, and until now this job did the app half alone — which is
 * why `feed` has never delivered an event despite being in
 * `REQUIRED_PAGE_FIELDS`. The second write installs this app on the Page with
 * the same field list, and needs a Page token rather than the app token.
 *
 * One object per run, deliberately. A single run that walked all three would
 * make its own output ambiguous — three reads, three merges and three write-back
 * checks, of which any one can fail — and the whole reason a person is watching
 * this job is to see exactly which field list changed.
 *
 * Unlike the cron handlers this fails loudly when the credentials are missing.
 * They skip because they fire on a schedule whether or not anyone is ready;
 * this one only ever runs because a person typed it, and a silent success would
 * leave them believing a change landed that did not.
 *
 * Safe to re-run: with nothing to add it reports the current state and writes
 * nothing.
 */
export async function subscribeMetaWebhooks(job?: ClaimedJob): Promise<void> {
  const object = resolveObject(job?.payload?.object);
  const want = REQUIRED_FIELDS[object]!;

  await subscribeApp(object, want);

  /*
    Unconditionally after the app half, and *not* inside it.

    The two subscriptions are independent, which is the whole reason this bug
    existed: the app level can already list `feed` — it has, since
    `REQUIRED_PAGE_FIELDS` was written — while the Page level has never carried
    it, and Meta delivers only what both agree on. Returning early from the app
    half because there was nothing to add there would skip the half that is
    actually missing, and report success.
  */
  if (object === PAGE_OBJECT || object === INSTAGRAM_OBJECT) await subscribePage(want);
}

async function subscribeApp(object: string, want: readonly string[]): Promise<void> {
  const existing = await readSubscription(object);

  // No subscription at all is not something to fix by writing one. Creating it
  // means choosing a callback URL, and picking that wrong points production
  // traffic at the wrong host — a worse outcome than stopping here.
  if (!existing) {
    throw new Error(
      `This app has no ${object} subscription. Create it in the App Dashboard — ` +
        `WhatsApp → Configuration, or the Messenger/Instagram use case's webhook ` +
        `settings — then re-run this job to add fields.`,
    );
  }

  const plan = planFieldSubscription(existing, want);

  console.log(`[subscribe_meta_webhooks] callback ${plan.callbackUrl}`);
  console.log(`[subscribe_meta_webhooks] subscribed now: ${plan.current.join(', ') || '(none)'}`);

  if (plan.adding.length === 0) {
    console.log('[subscribe_meta_webhooks] app-level nothing to add — already subscribed');
    return;
  }

  if (!existing.active) {
    // Worth saying out loud rather than refusing: the field list is still worth
    // fixing, but an inactive subscription delivers nothing, and that would
    // otherwise look like the echoes never being enabled.
    console.warn(
      '[subscribe_meta_webhooks] the subscription is marked inactive — Meta ' +
        'disables one whose callback has been failing. Fields will be updated, ' +
        'but nothing is delivered until it is active again.',
    );
  }

  console.log(
    `[subscribe_meta_webhooks] adding ${plan.adding.join(', ')} → writing ` +
      `${plan.merged.join(', ')}`,
  );

  await applyFieldSubscription(plan);

  // Read back rather than trusting the 200. This job's whole job is the field
  // list, and Graph accepting a write is not the same as Graph having stored
  // the field — an unavailable field is the case that would otherwise be
  // reported as success.
  const after = await readSubscription(object);
  const now = after?.fields.map((field) => field.name) ?? [];
  const missing = plan.merged.filter((field) => !now.includes(field));

  if (missing.length > 0) {
    throw new Error(
      `Graph accepted the write but ${missing.join(', ')} is not subscribed. ` +
        `Subscribed fields are now: ${now.join(', ') || '(none)'}`,
    );
  }

  console.log(`[subscribe_meta_webhooks] app-level done — subscribed: ${now.join(', ')}`);
}

/**
 * The Page half of a subscription — now for Instagram as well as for the Page.
 *
 * This used to run only for `object=page`, on the reasoning that
 * `subscribed_apps` takes *Page* field names and that whether a Page-connected
 * Instagram account needs anything beyond the app being installed was not
 * established. **Meta's documentation establishes it**: the Instagram webhook
 * setup is a `POST /me/subscribed_apps?subscribed_fields=comments,messages`,
 * where `/me` is "your app user's Instagram professional account ID or the
 * Facebook Page ID that is linked to it" — so on this connection the Page id is
 * the target and `comments` belongs in its field list. The old comment was an
 * honest "we have not checked"; it is checked now.
 *
 * That makes the Page's list a union across both products rather than one
 * product's list, which is why `planPageSubscription` merges instead of
 * replacing: writing Instagram's two fields wholesale would drop `feed` and take
 * Facebook comments down with it — the exact accident the merge exists to
 * prevent. The read-back below is what catches the other direction, a field name
 * Graph will not accept on a Page.
 *
 * This is the second gate, not the first. Delivery also needs Advanced Access on
 * `instagram_manage_comments` (§6.34), so a correct field list here does not by
 * itself make a comment arrive — it makes the approval, when it lands, turn the
 * channel on rather than start another search.
 *
 * Run after the app-level write rather than before, so a run that fails here
 * leaves the app-level list already correct and the second half is all that is
 * left to retry.
 */
async function subscribePage(want: readonly string[]): Promise<void> {
  const pageId = configuredAccountId('facebook');
  if (!pageId) {
    throw new Error(
      'FACEBOOK_PAGE_ID is not set, so the Page half of this subscription cannot be ' +
        'addressed. The app-level field list is already updated; set it and re-run.',
    );
  }

  const current = await readPageSubscription(pageId);
  const plan = planPageSubscription(pageId, current, want);

  if (!plan.installed) {
    // Worth its own line: this is the state that explains a Page field which has
    // been subscribed at the app level for months and never delivered anything.
    console.warn(
      `[subscribe_meta_webhooks] this app is not installed on Page ${pageId} — no Page ` +
        `event has ever been deliverable. Installing it now.`,
    );
  } else {
    console.log(
      `[subscribe_meta_webhooks] page ${pageId} subscribed now: ` +
        `${plan.current.join(', ') || '(none)'}`,
    );
  }

  if (plan.installed && plan.adding.length === 0) {
    console.log('[subscribe_meta_webhooks] page-level nothing to add — already subscribed');
    return;
  }

  console.log(`[subscribe_meta_webhooks] page-level writing ${plan.merged.join(', ')}`);
  await applyPageSubscription(plan);

  // Read back, for the same reason the app-level write does: Graph accepting a
  // field list is not Graph having stored it, and this job exists to leave
  // somebody certain rather than hopeful.
  const after = await readPageSubscription(pageId);
  const missing = plan.merged.filter((field) => !(after ?? []).includes(field));

  if (missing.length > 0) {
    throw new Error(
      `Graph accepted the page-level write but ${missing.join(', ')} is not subscribed on ` +
        `Page ${pageId}. Subscribed fields are now: ${(after ?? []).join(', ') || '(none)'}`,
    );
  }

  console.log(
    `[subscribe_meta_webhooks] page-level done — subscribed: ${(after ?? []).join(', ')}`,
  );
}
