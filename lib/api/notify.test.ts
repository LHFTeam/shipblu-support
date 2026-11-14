import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { lastAttemptAfterSeconds, mybluWebhookConfigured, NOTIFY_MAX_ATTEMPTS } from './notify';
import { MAX_EVENT_AGE_MS, WEBHOOK_TIMEOUT_MS } from './webhook';

/**
 * The two bounds the guide gives myBlu's receiver (`docs/myblu-api.md`, _The
 * webhook_), held to the queue's own backoff: retries stop within a day of the
 * event, since the receiver dedupes for a day, and they go on long enough that
 * a receiver's own deploy does not cost a push.
 */

const DAY_SECONDS = 24 * 60 * 60;

describe('the delivery schedule', () => {
  it('spends its last attempt within a day of the first, every attempt waiting out its deadline', () => {
    const lastStartsAfter = lastAttemptAfterSeconds();
    const lastEndsBy = lastStartsAfter + (NOTIFY_MAX_ATTEMPTS * WEBHOOK_TIMEOUT_MS) / 1000;

    // About seventeen hours, as `NOTIFY_MAX_ATTEMPTS` says.
    expect(lastStartsAfter).toBe(60_690);
    expect(lastEndsBy).toBeLessThan(DAY_SECONDS);
    // And inside the age the job itself refuses past, so a queue that is late
    // ends the retries at that age rather than past the receiver's day.
    expect(lastEndsBy * 1000).toBeLessThan(MAX_EVENT_AGE_MS);
    expect(MAX_EVENT_AGE_MS).toBeLessThan(DAY_SECONDS * 1000);
  });

  it('outlasts a receiver down for hours, where the queue’s default of five gives up in minutes', () => {
    expect(lastAttemptAfterSeconds(5)).toBe(300);
    expect(lastAttemptAfterSeconds()).toBeGreaterThan(12 * 60 * 60);
  });
});

describe('mybluWebhookConfigured', () => {
  withTestEnv();

  it('is the URL set, and nothing else', () => {
    expect(mybluWebhookConfigured()).toBe(false);
    setTestEnv({ MYBLU_WEBHOOK_URL: '   ' });
    expect(mybluWebhookConfigured()).toBe(false);
    // Whether it is usable is the worker's to say, by name, on every job.
    setTestEnv({ MYBLU_WEBHOOK_URL: 'http://not-https.example.test' });
    expect(mybluWebhookConfigured()).toBe(true);
  });
});
