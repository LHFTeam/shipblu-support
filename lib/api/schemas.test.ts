import { describe, expect, it } from 'vitest';
import { ListMessagesQuery } from './schemas';

/**
 * What a schema refuses that the document cannot say. The document is
 * `openapi.test.ts`'s; a rule `z.toJSONSchema` drops, such as a refinement
 * across two fields, is held here, since the route parses with the schema and
 * not with the document.
 */

const AFTER = 'MjAyNi0xMS0xMiAwOTo0MTowNy4wMDQyMTMrMDB8YQ';
const BEFORE = 'MjAyNi0xMS0xMiAwOToyOTo1OC4xMjMrMDB8Yg';

describe('ListMessagesQuery', () => {
  it('takes no cursor, or either one alone', () => {
    expect(ListMessagesQuery.parse({})).toEqual({ limit: 30 });
    expect(ListMessagesQuery.parse({ after: AFTER })).toEqual({ after: AFTER, limit: 30 });
    expect(ListMessagesQuery.parse({ before: BEFORE, limit: '50' })).toEqual({
      before: BEFORE,
      limit: 50,
    });
  });

  it('refuses `after` and `before` together, naming neither as the field to blame', () => {
    const result = ListMessagesQuery.safeParse({ after: AFTER, before: BEFORE });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: 'custom', path: [] })]);
  });
});
