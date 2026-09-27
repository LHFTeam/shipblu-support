import { describe, expect, it } from 'vitest';
import { enqueue, PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from './payloads';

function job(payload: Record<string, unknown>): ClaimedJob {
  return { id: 'job-1', type: 'send_email', payload } as unknown as ClaimedJob;
}

describe('parseJobPayload', () => {
  it('hands back the fields its schema declares, and drops the rest', () => {
    expect(parseJobPayload(job({ messageId: 'm-1', stray: true }), 'send_email')).toEqual({
      messageId: 'm-1',
    });
  });

  it('fails a payload no retry can fix for good, naming the job and the field', () => {
    const run = () => parseJobPayload(job({ messageId: 42 }), 'send_email');

    expect(run).toThrow(PermanentJobError);
    expect(run).toThrow(/^send_email: invalid payload — .*"messageId"/s);
  });

  it('reads a missing payload field as invalid, not as undefined', () => {
    expect(() => parseJobPayload(job({}), 'send_whatsapp')).toThrow(PermanentJobError);
  });
});

describe('the inbound family', () => {
  const parse = (type: Parameters<typeof parseJobPayload>[1], payload: Record<string, unknown>) =>
    parseJobPayload(job(payload), type);

  it('reads a Meta attachment and a WhatsApp one as the two halves of download_media', () => {
    expect(
      parse('download_media', { source: 'meta', messageId: 'm-1', url: 'https://cdn.example/a' }),
    ).toEqual({ source: 'meta', messageId: 'm-1', url: 'https://cdn.example/a' });
    expect(parse('download_media', { messageId: 'm-1', mediaId: 'wa-1' })).toEqual({
      messageId: 'm-1',
      mediaId: 'wa-1',
    });
  });

  it('refuses a Meta attachment with no URL rather than reading it as WhatsApp media', () => {
    expect(() =>
      parse('download_media', { source: 'meta', messageId: 'm-1', mediaId: 'wa-1' }),
    ).toThrow(PermanentJobError);
  });

  it('turns a tracking number typed at `npm run job` back into the string it was', () => {
    expect(parse('sync_shipment', { trackingNumber: 1755021358719 })).toEqual({
      trackingNumber: '1755021358719',
    });
  });

  it('refuses a sync that names no shipment', () => {
    expect(() => parse('sync_shipment', { force: true })).toThrow(
      /requires a shipmentId or a trackingNumber/,
    );
  });

  it('refuses a moderation nobody can perform', () => {
    expect(() => parse('moderate_meta_comment', { messageId: 'm-1', action: 'pin' })).toThrow(
      PermanentJobError,
    );
    expect(
      parse('moderate_meta_comment', { messageId: 'm-1', action: 'hide', agentId: null }),
    ).toEqual({ messageId: 'm-1', action: 'hide', agentId: null });
  });

  // Recorded, and said in the PR: before the schema, `force=yes` was read as
  // `force !== true` and ran without forcing. Now it is refused, and nothing runs.
  it('takes force only as a boolean', () => {
    const profile = { contactId: 'c-1', platform: 'instagram', userId: 'u-1' };
    expect(parse('fetch_meta_profile', { ...profile, force: true })).toEqual({
      ...profile,
      force: true,
    });
    expect(() => parse('fetch_meta_profile', { ...profile, force: 'yes' })).toThrow(
      PermanentJobError,
    );
  });
});

// Never called: `tsc` is the assertion. Each line below the directive must fail
// to compile, and would compile if `enqueue` were typed `Record<string, unknown>`.
async function enqueueIsTypedFromTheSchema(messageId: string) {
  await enqueue('send_email', { messageId });
  await enqueue('cleanup', {});
  // @ts-expect-error a send without the message it sends
  await enqueue('send_email', {});
  // @ts-expect-error an id of the wrong type
  await enqueue('send_whatsapp', { messageId: 42 });
  // @ts-expect-error the payload of another job
  await enqueue('send_agent_invite', { messageId });
  // @ts-expect-error a profile on a platform that has none
  await enqueue('fetch_meta_profile', { contactId: 'c', platform: 'email', userId: 'u' });
  // @ts-expect-error a moderation that does not exist
  await enqueue('moderate_meta_comment', { messageId, action: 'pin' });
}
void enqueueIsTypedFromTheSchema;
