import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A vote is counted for a customer and not for the team. `helpfulCount` orders
 * the related articles a customer is shown, and the inbox links agents straight
 * to the help centre, so an agent's "yes, helpful" on a procedure they re-read
 * all day would reorder what customers see.
 */

const select = vi.fn(() => {
  throw new Error('the database was asked to record a console reader’s vote');
});
vi.mock('@/db/client', () => ({ db: { select } }));

const { POST } = await import('./route');

function vote(headers: Record<string, string>) {
  return POST(
    new Request('https://support.example/api/kb/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        articleId: '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44',
        wasHelpful: true,
      }),
    }),
  );
}

beforeEach(() => {
  select.mockClear();
});

describe('POST /api/kb/feedback', () => {
  it('thanks a reader signed in to the console without recording the vote', async () => {
    const response = await vote({
      'x-forwarded-for': '198.51.100.10',
      cookie: 'shipblu_session=abc',
    });

    expect(response.status).toBe(204);
    expect(select).not.toHaveBeenCalled();
  });

  it('still records a customer’s vote', async () => {
    await expect(vote({ 'x-forwarded-for': '198.51.100.11' })).rejects.toThrow(/console reader/);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
