import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ enqueueMany: vi.fn() }));

vi.mock('@/lib/queue', () => ({ enqueueMany: mocks.enqueueMany }));

import { enqueueNotificationEmail, enqueueNotificationEmails } from './notify';

const mail = (to: string) => ({ to, subject: 's', textBody: 't', htmlBody: '<p>t</p>' });

describe('enqueueNotificationEmail', () => {
  beforeEach(() => {
    mocks.enqueueMany.mockReset();
  });

  // A spread under the default let `{ priority: undefined }` through, and the
  // queue then took a sign-in link at its own default of 100 instead of 40.
  it('keeps priority 40 when the caller passes none, or passes undefined', async () => {
    await enqueueNotificationEmail(mail('a@example.com'));
    await enqueueNotificationEmail(mail('a@example.com'), { priority: undefined });

    expect(mocks.enqueueMany).toHaveBeenCalledTimes(2);
    for (const [, , options] of mocks.enqueueMany.mock.calls) {
      expect(options).toMatchObject({ priority: 40 });
    }
  });

  it('queues several in one insert, on the transaction and at the priority it is given', async () => {
    // Only passed through, so any stand-in for a transaction will do.
    const tx = { insert: vi.fn() } as never;
    await enqueueNotificationEmails([mail('a@example.com'), mail('b@example.com')], {
      on: tx,
      priority: 60,
    });

    expect(mocks.enqueueMany).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMany).toHaveBeenCalledWith(
      'send_notification_email',
      [mail('a@example.com'), mail('b@example.com')],
      { on: tx, priority: 60 },
    );
  });
});
