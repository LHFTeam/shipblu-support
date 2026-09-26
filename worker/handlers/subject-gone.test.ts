import { describe, expect, it, vi } from 'vitest';

/**
 * A job a worker claimed before an admin purge cancelled it finds its subject
 * row gone. It must go dead on that first attempt — a plain `Error` spends the
 * whole retry budget re-reading a row that cannot come back.
 */

// Any query, however it is chained, resolves to no rows: the subject is gone.
vi.mock('@/db/client', () => {
  const empty: unknown = new Proxy(() => {}, {
    get: (_target, key) =>
      key === 'then' ? (resolve: (rows: unknown[]) => unknown) => resolve([]) : () => empty,
  });
  return { db: empty };
});

const { PermanentJobError } = await import('@/lib/queue');
const { sendEmail } = await import('./send-email');
const { sendSideEmail } = await import('./send-side-email');
const { sendWhatsApp } = await import('./send-whatsapp');
const { sendMeta } = await import('./send-meta');
const { moderateMetaComment } = await import('./moderate-meta-comment');

type Handler = (job: never) => Promise<void>;

const cases: [string, Handler, Record<string, unknown>][] = [
  ['send_email', sendEmail, {}],
  ['send_side_email', sendSideEmail, {}],
  ['send_whatsapp', sendWhatsApp, {}],
  ['send_meta', sendMeta, {}],
  ['moderate_meta_comment', moderateMetaComment, { action: 'hide' }],
];

describe('senders whose message was purged', () => {
  it.each(cases)('%s fails for good, naming the message', async (type, handler, extra) => {
    const job = { id: 'job-1', type, payload: { messageId: 'gone-1', ...extra } } as never;

    const failure = handler(job);
    await expect(failure).rejects.toBeInstanceOf(PermanentJobError);
    await expect(failure).rejects.toThrow(/gone-1 no longer exists/);
  });
});
