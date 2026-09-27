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
}
void enqueueIsTypedFromTheSchema;
