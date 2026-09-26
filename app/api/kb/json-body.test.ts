import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the public knowledge base and CSAT routes answer for a body they cannot
 * use.
 *
 * Each read its body with `(await request.json()) as typeof body` inside a
 * `try`. That refuses text that is not JSON, and lets through JSON that is not
 * an object — harmless for a number, a string or an array, whose fields all
 * read as undefined, and a 500 for `null`, where reading the first field threw.
 * Every refusal here is an empty 400, so all of them are pinned as that.
 */

const recordResponse = vi.fn(async () => undefined);
const recordArticleView = vi.fn(async () => undefined);
const select = vi.fn(() => {
  throw new Error('the database was reached');
});

vi.mock('@/lib/csat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csat')>()),
  recordResponse,
}));
vi.mock('@/lib/kb/queries', () => ({ recordArticleView }));
vi.mock('@/db/client', () => ({ db: { select } }));

const csat = await import('./csat/route');
const feedback = await import('./feedback/route');
const view = await import('./view/route');

const ARTICLE = '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44';

// A fresh address per request, so no test spends another's rate limit.
let address = 0;
function post(body: string): Request {
  address += 1;
  return new Request('https://help.example/api/kb', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.${Math.floor(address / 250)}.${address % 250}`,
    },
  });
}

async function refused(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.text()).toBe('');
}

beforeEach(() => {
  recordResponse.mockClear();
  recordArticleView.mockClear();
  select.mockClear();
});

const ROUTES = [
  {
    route: 'csat',
    POST: csat.POST,
    unusable: [{ rating: 5 }, { token: '', rating: 5 }, { token: 5, rating: 5 }, { token: 't' }],
  },
  {
    route: 'feedback',
    POST: feedback.POST,
    unusable: [
      { wasHelpful: true },
      { articleId: 'not-a-uuid', wasHelpful: true },
      { articleId: ARTICLE },
      { articleId: ARTICLE, wasHelpful: 'yes' },
    ],
  },
  {
    route: 'view',
    POST: view.POST,
    unusable: [{}, { articleId: 'not-a-uuid' }, { articleId: 5 }],
  },
];

describe.each(ROUTES)('POST /api/kb/$route', ({ POST, unusable }) => {
  it('refuses a body that is not JSON', async () => {
    await refused(await POST(post('{not json')));
  });

  it('refuses JSON null the same way, rather than with a 500', async () => {
    await refused(await POST(post('null')));
  });

  it.each(['5', '"text"', '[]', 'true'])('refuses JSON that is not an object: %s', async (body) => {
    await refused(await POST(post(body)));
  });

  it('refuses an object missing a field it needs, or holding the wrong type', async () => {
    for (const body of unusable) {
      await refused(await POST(post(JSON.stringify(body))));
    }
    expect(recordResponse).not.toHaveBeenCalled();
    expect(recordArticleView).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});

describe('a usable body', () => {
  it('records a rating, dropping a comment that is not text rather than refusing it', async () => {
    const response = await csat.POST(post(JSON.stringify({ token: 't', rating: 4, comment: 5 })));

    expect(response.status).toBe(204);
    expect(recordResponse).toHaveBeenCalledWith('t', 4, null);
  });

  it('records a rating with its comment', async () => {
    await csat.POST(post(JSON.stringify({ token: 't', rating: 2, comment: ' slow ' })));

    expect(recordResponse).toHaveBeenCalledWith('t', 2, ' slow ');
  });

  it('takes feedback with a comment that is not text as far as the database', async () => {
    const body = { articleId: ARTICLE, wasHelpful: false, comment: 5 };

    await expect(feedback.POST(post(JSON.stringify(body)))).rejects.toThrow(/database was reached/);
    expect(select).toHaveBeenCalledOnce();
  });

  it('counts a view', async () => {
    const response = await view.POST(post(JSON.stringify({ articleId: ARTICLE })));

    expect(response.status).toBe(204);
    expect(recordArticleView).toHaveBeenCalledWith(ARTICLE);
  });
});
