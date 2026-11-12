import { describe, expect, it } from 'vitest';
import { insertedArticleLink } from './agent-link';

describe('insertedArticleLink', () => {
  // The knowledge panel's Insert: a reply reaches a customer, so the link is
  // the one on the published host, never the one the agent reads on.
  it('puts the title, then the link to send, on its own line', () => {
    expect(
      insertedArticleLink({
        title: 'إرشادات التعبئة',
        sendUrl: 'https://support.shipblu.com/ar/a/x',
      }),
    ).toBe('إرشادات التعبئة\nhttps://support.shipblu.com/ar/a/x');
  });
});
