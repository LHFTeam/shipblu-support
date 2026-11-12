import { describe, expect, it } from 'vitest';
import { echoDisposition, echoSourceOf, PAGE_INBOX_APP_ID } from './echo';

const OURS = '1009187740467732';

describe('echoDisposition', () => {
  const echo = (overrides: Partial<Parameters<typeof echoDisposition>[0]> = {}) => ({
    platform: 'facebook' as const,
    appId: PAGE_INBOX_APP_ID,
    standby: false,
    ...overrides,
  });

  it('files a Business Suite reply on a thread this app holds', () => {
    expect(echoDisposition(echo(), OURS)).toBe('file');
  });

  it('files any other named app on a thread this app holds', () => {
    // On a thread this app owns nothing but the Page Inbox may send beside us,
    // so a third app here has sent something only a person could have asked
    // it to; its label says which app, not that it was Business Suite.
    expect(echoDisposition(echo({ appId: '576817601276249' }), OURS)).toBe('file');
  });

  it('drops our own send, wherever it arrived', () => {
    expect(echoDisposition(echo({ appId: OURS }), OURS)).toBe('own');
    expect(echoDisposition(echo({ appId: OURS, standby: true }), OURS)).toBe('own');
  });

  it('drops what another app sent while it held the thread', () => {
    expect(echoDisposition(echo({ standby: true }), OURS)).toBe('standby');
  });

  it('files nothing it cannot attribute', () => {
    // Without our own id an echo of our reply reads as another app's, and
    // filing it would put every reply on the ticket twice.
    expect(echoDisposition(echo(), null)).toBe('unattributed');
    expect(echoDisposition(echo(), '')).toBe('unattributed');
    expect(echoDisposition(echo({ appId: null }), OURS)).toBe('unattributed');
  });

  it('files no Instagram echo, named or not', () => {
    expect(echoDisposition(echo({ platform: 'instagram', appId: null }), OURS)).toBe('instagram');
    expect(echoDisposition(echo({ platform: 'instagram' }), OURS)).toBe('instagram');
  });
});

describe('echoSourceOf', () => {
  it('names Business Suite by the Page Inbox app, and nothing else', () => {
    expect(echoSourceOf(PAGE_INBOX_APP_ID)).toBe('meta_business_suite');
    expect(echoSourceOf('576817601276249')).toBe('other_app');
  });
});
