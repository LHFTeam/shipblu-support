import {
  applyFieldSubscription,
  planFieldSubscription,
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
    console.log('[subscribe_meta_webhooks] nothing to add — already subscribed');
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

  console.log(`[subscribe_meta_webhooks] done — subscribed: ${now.join(', ')}`);
}
