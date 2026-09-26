import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An admin purge can delete a message while its media job is queued, or while
 * a worker is already holding it. Either way the job must end for good rather
 * than retry, and must not leave an object in the bucket that no row names —
 * the purge finds keys through those rows, so it could never find this one.
 */

const state = vi.hoisted(() => ({
  /** What each successive `select … limit()` resolves to, in call order. */
  reads: [] as unknown[][],
  inserts: [] as unknown[],
}));

// Every query builder in the handler ends in a `limit()`, optionally followed
// by `.for('share')`; both are awaited, so one thenable chain covers them.
function chain(): unknown {
  const rows = () => state.reads.shift() ?? [];
  const node: Record<string, unknown> = {};
  for (const step of ['select', 'from', 'where']) node[step] = () => node;
  node.limit = () => {
    const result = rows();
    return {
      for: async () => result,
      then: (resolve: (value: unknown) => unknown) => resolve(result),
    };
  };
  node.insert = () => ({
    values: async (value: unknown) => {
      state.inserts.push(value);
    },
  });
  node.update = () => ({ set: () => ({ where: async () => {} }) });
  return node;
}

vi.mock('@/db/client', () => {
  const db = chain() as Record<string, unknown>;
  db.transaction = async (run: (tx: unknown) => Promise<unknown>) => run(chain());
  return { db };
});

const storage = vi.hoisted(() => ({
  uploadObject: vi.fn(async (path: string) => ({ path, sizeBytes: 3, checksum: 'c' })),
  removeObjects: vi.fn(async () => ({ failed: [] as string[] })),
  buildAttachmentPath: (conversationId: string, key: string, filename: string) =>
    `conversations/${conversationId}/${key}/${filename}`,
}));
vi.mock('@/lib/storage', () => storage);

const remote = vi.hoisted(() => ({
  downloadAttachment: vi.fn(async () => ({
    content: Buffer.from('abc'),
    contentType: 'image/jpeg',
  })),
  getMediaUrl: vi.fn(async () => ({ url: 'https://example.test/m', mimeType: 'image/jpeg' })),
  downloadMedia: vi.fn(async () => ({ content: Buffer.from('abc'), contentType: 'image/jpeg' })),
}));
vi.mock('@/lib/meta/client', () => ({
  downloadAttachment: remote.downloadAttachment,
  MetaApiError: class extends Error {},
}));
vi.mock('@/lib/whatsapp/client', () => ({
  getMediaUrl: remote.getMediaUrl,
  downloadMedia: remote.downloadMedia,
  WhatsAppApiError: class extends Error {},
}));
vi.mock('@/lib/whatsapp/accounts', () => ({
  credentialsForPhoneNumberId: async () => ({ token: 't' }),
}));

const { PermanentJobError } = await import('@/lib/queue');
const { downloadMediaJob } = await import('./download-media');

const MESSAGE = { id: 'm-1', conversationId: 'c-1', meta: {} };

const jobs = {
  whatsapp: { payload: { messageId: 'm-1', mediaId: 'media-1' } },
  meta: { payload: { messageId: 'm-1', source: 'meta', url: 'https://cdn.test/x', index: 0 } },
} as unknown as Record<'whatsapp' | 'meta', Parameters<typeof downloadMediaJob>[0]>;

beforeEach(() => {
  state.reads = [];
  state.inserts = [];
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('downloadMediaJob when the message has been purged', () => {
  it.each(['whatsapp', 'meta'] as const)(
    'fails a %s job for good before fetching or storing anything',
    async (source) => {
      state.reads = [[]];

      await expect(downloadMediaJob(jobs[source])).rejects.toBeInstanceOf(PermanentJobError);
      expect(remote.downloadAttachment).not.toHaveBeenCalled();
      expect(remote.getMediaUrl).not.toHaveBeenCalled();
      expect(storage.uploadObject).not.toHaveBeenCalled();
    },
  );

  it.each(['whatsapp', 'meta'] as const)(
    'removes the %s object it stored when the message went mid-download',
    async (source) => {
      // Found at the start (and, for Meta, not already stored), gone at the lock.
      state.reads = source === 'meta' ? [[MESSAGE], [], []] : [[MESSAGE], []];

      await expect(downloadMediaJob(jobs[source])).rejects.toBeInstanceOf(PermanentJobError);
      const stored = storage.uploadObject.mock.calls[0]![0];
      expect(storage.removeObjects).toHaveBeenCalledWith([stored]);
      expect(state.inserts).toEqual([]);
    },
  );

  it.each(['whatsapp', 'meta'] as const)(
    'records the %s attachment when the message is still there',
    async (source) => {
      state.reads = source === 'meta' ? [[MESSAGE], [], [MESSAGE]] : [[MESSAGE], [MESSAGE]];

      await downloadMediaJob(jobs[source]);
      expect(storage.removeObjects).not.toHaveBeenCalled();
      expect(state.inserts).toHaveLength(1);
    },
  );
});
