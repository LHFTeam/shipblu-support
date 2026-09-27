import { configuredAccountId } from '@/lib/meta/client';
import { instagramLoginConfigured } from '@/lib/meta/connection';
import {
  applyFieldSubscription,
  applyInstagramLoginSubscription,
  applyPageSubscription,
  INSTAGRAM_OBJECT,
  PAGE_OBJECT,
  planFieldSubscription,
  planInstagramLoginSubscription,
  planPageSubscription,
  readInstagramLoginSubscription,
  readPageSubscription,
  readSubscription,
  REQUIRED_FIELDS,
  resolveObject,
} from '@/lib/meta/subscriptions';
import type { ClaimedJob } from '@/lib/queue';
import { logger } from '@/lib/log';

const log = logger('subscribe_meta_webhooks');

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
 * **`object=page` and `object=instagram` each do two writes, because a webhook
 * has two subscriptions.** Meta only delivers a field subscribed at *both* the
 * app level and the account level, and this job once did the app half alone —
 * which is why `feed` never delivered an event despite being in
 * `REQUIRED_PAGE_FIELDS`. The second write is addressed to the account and needs
 * that account's own credential:
 *
 *   object=page        the Page's subscribed_apps, with the Page token
 *   object=instagram   the Instagram account's subscribed_apps on
 *                      graph.instagram.com, with INSTAGRAM_ACCESS_TOKEN —
 *                      skipped when that is unset, because then the Page half
 *                      above is the only account-level subscription Instagram
 *                      has and `object=page` already writes it
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
  if (object === PAGE_OBJECT) await subscribePage(want);

  /*
    The direct Instagram connection's own account-level half.

    Conditional on the credential rather than on a flag, the same way every other
    decision about this connection is: a deployment without the token has no
    direct connection to subscribe, and the Page half written by `object=page` is
    the only account-level subscription its Instagram traffic has.

    Note this runs for `object=instagram` and never for `object=page`, even
    though the Page half of Instagram's delivery is written by the latter. The
    two are different subscriptions on different hosts that happen to concern the
    same account, and folding them into one run would make the output ambiguous
    about which one changed — which is the failure the one-object-per-run rule
    above exists to prevent.
  */
  if (object === INSTAGRAM_OBJECT && instagramLoginConfigured()) {
    await subscribeInstagramLogin(want);
  } else if (object === INSTAGRAM_OBJECT) {
    log.info(
      'INSTAGRAM_ACCESS_TOKEN is unset, so there is no direct ' +
        'Instagram connection to subscribe — the Page half is written by object=page',
    );
  }
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

  log.info(`callback ${plan.callbackUrl}`);
  log.info(`subscribed now: ${plan.current.join(', ') || '(none)'}`);

  if (plan.adding.length === 0) {
    log.info('app-level nothing to add — already subscribed');
    return;
  }

  if (!existing.active) {
    // Worth saying out loud rather than refusing: the field list is still worth
    // fixing, but an inactive subscription delivers nothing, and that would
    // otherwise look like the echoes never being enabled.
    log.warn(
      'the subscription is marked inactive — Meta ' +
        'disables one whose callback has been failing. Fields will be updated, ' +
        'but nothing is delivered until it is active again.',
    );
  }

  log.info(`adding ${plan.adding.join(', ')} → writing ${plan.merged.join(', ')}`);

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

  log.info(`app-level done — subscribed: ${now.join(', ')}`);
}

/**
 * The Page half of a Page subscription.
 *
 * **Only for `object=page`. Instagram's fields never go here**, and the reason is
 * worth keeping written down because it was got wrong once. Meta's Instagram
 * webhook setup doc shows
 * `POST /me/subscribed_apps?subscribed_fields=comments,messages`, which was read
 * as "the Page subscription must carry `comments`" and turned into code. It does
 * not: the curl is addressed to **`graph.instagram.com/{ig-account-id}`**, which
 * is the *Instagram Login* product, where `/me` is the Instagram account and
 * `comments` is one of its fields. That call is now made — by
 * `subscribeInstagramLogin` below, to the host the doc actually names. Here
 * `subscribed_apps` is addressed to the **Page**, which takes Page field names, a
 * vocabulary with no `comments` in it at all. Facebook's comments arrive under
 * `feed`.
 *
 * Meta's own Webhook Debugger states the rule for this connection outright:
 * *"For Instagram, app level webhook subscription is required via the Webhooks
 * product."* Confirmed against Page `101449698657189` on 2026-08-30 — the app's
 * IG subscription lists `comments`, the Page's field list does not and is not
 * supposed to, and the account shows as linked with messaging on.
 *
 * So writing Instagram's fields here would have put an invalid field name into a
 * live, working Page's list. The merge and the read-back would have caught it
 * loudly rather than breaking `feed`, but a guess that survives only because the
 * safety net holds is still a guess. §6.26's lesson generalises past app
 * secrets: **the two Instagram connections differ in the host, the token, the
 * ids and the field vocabulary, so a doc example proves nothing until you check
 * which one it is addressed to.**
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
    log.warn(
      `this app is not installed on Page ${pageId} — no Page ` +
        `event has ever been deliverable. Installing it now.`,
    );
  } else {
    log.info(`page ${pageId} subscribed now: ${plan.current.join(', ') || '(none)'}`);
  }

  if (plan.installed && plan.adding.length === 0) {
    log.info('page-level nothing to add — already subscribed');
    return;
  }

  log.info(`page-level writing ${plan.merged.join(', ')}`);
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

  log.info(`page-level done — subscribed: ${(after ?? []).join(', ')}`);
}

/**
 * The account-level half for the direct Instagram connection.
 *
 * Addressed to `graph.instagram.com/{ig-id}/subscribed_apps` with
 * `INSTAGRAM_ACCESS_TOKEN`. Same shape as the Page half above and a different
 * request in every particular — host, node, credential, and the field vocabulary
 * it accepts.
 *
 * The account id is `INSTAGRAM_ACCOUNT_ID`, which is the same value on both
 * connections: one Instagram professional account, one id, whichever way it is
 * reached (verified against production traffic, `docs/PROJECT-STATE.md` §6.29).
 * Meta's example uses `/me` instead, and naming the id is the better of the two
 * here — `/me` would silently subscribe whatever account the token happens to
 * belong to, and a token pointing somewhere unexpected is exactly the failure
 * this deployment has already had twice.
 */
async function subscribeInstagramLogin(want: readonly string[]): Promise<void> {
  const accountId = configuredAccountId('instagram');
  if (!accountId) {
    throw new Error(
      'INSTAGRAM_ACCOUNT_ID is not set, so the direct Instagram connection cannot be ' +
        'addressed. The app-level field list is already updated; set it and re-run.',
    );
  }

  const current = await readInstagramLoginSubscription(accountId);
  const plan = planInstagramLoginSubscription(accountId, current, want);

  if (!plan.subscribed) {
    // The state that explains an account delivering nothing while every
    // permission reads as granted.
    log.warn(
      `the direct connection has no subscription on account ` +
        `${accountId} — no event has ever been deliverable over it. Subscribing now.`,
    );
  } else {
    log.info(`instagram_login ${accountId} subscribed now: ${plan.current.join(', ') || '(none)'}`);
  }

  if (plan.subscribed && plan.adding.length === 0) {
    log.info('instagram_login nothing to add — already subscribed');
    return;
  }

  log.info(`instagram_login writing ${plan.merged.join(', ')}`);
  await applyInstagramLoginSubscription(plan);

  // Read back, as both other levels do. Meta answers this POST with
  // `{"success": true}` and nothing else, so the write's own response cannot
  // report which fields were stored.
  const after = await readInstagramLoginSubscription(accountId);
  const missing = plan.merged.filter((field) => !(after ?? []).includes(field));

  if (missing.length > 0) {
    throw new Error(
      `Graph accepted the write but ${missing.join(', ')} is not subscribed on Instagram ` +
        `account ${accountId}. Subscribed fields are now: ${(after ?? []).join(', ') || '(none)'}`,
    );
  }

  log.info(`instagram_login done — subscribed: ${(after ?? []).join(', ')}`);
}
