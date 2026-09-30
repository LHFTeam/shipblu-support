import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A view is counted for a customer and not for the team. The inbox links agents
 * straight to the help centre, so without the cookie check their re-reading of
 * the same few procedures would rank those articles on the public front page.
 */

const recordArticleView = vi.fn(async () => {});
vi.mock('@/lib/kb/queries', () => ({ recordArticleView }));

const { POST } = await import('./route');

const ARTICLE = '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44';

function view(headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('https://support.example/api/kb/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ articleId: ARTICLE }),
    }),
  );
}

beforeEach(() => {
  recordArticleView.mockClear();
});

describe('POST /api/kb/view', () => {
  it('counts a customer reading an article', async () => {
    const response = await view({ 'x-forwarded-for': '198.51.100.1' });

    expect(response.status).toBe(204);
    expect(recordArticleView).toHaveBeenCalledWith(ARTICLE);
  });

  it('does not count a reader signed in to the console', async () => {
    const response = await view({
      'x-forwarded-for': '198.51.100.2',
      cookie: 'shipblu_session=abc',
    });

    expect(response.status).toBe(204);
    expect(recordArticleView).not.toHaveBeenCalled();
  });

  it('still counts a customer signed in to the portal, which is a different cookie', async () => {
    const response = await view({
      'x-forwarded-for': '198.51.100.3',
      cookie: 'shipblu_customer=abc',
    });

    expect(response.status).toBe(204);
    expect(recordArticleView).toHaveBeenCalledWith(ARTICLE);
  });
});
