import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_CODE,
  explainAuthError,
  explainDeliveryError,
  RE_ENGAGEMENT_CODE,
} from './errors';

const META_TEXT =
  '131047: Re-engagement message — Message failed to send because more than 24 hours have passed since the customer last replied to this number.';

describe('explainDeliveryError', () => {
  it('names the mismatched numbers when they differ', () => {
    const explained = explainDeliveryError(RE_ENGAGEMENT_CODE, META_TEXT, {
      windowOpen: true,
      inboundPhoneNumberId: '838961722630554',
      sentFromPhoneNumberId: '102461866145442',
    });

    expect(explained).toContain(META_TEXT);
    expect(explained).toContain('838961722630554');
    expect(explained).toContain('102461866145442');
    expect(explained).toContain('WHATSAPP_PHONE_NUMBER_ID');
  });

  it('still explains when only one number is known but the window is open', () => {
    const explained = explainDeliveryError(RE_ENGAGEMENT_CODE, META_TEXT, { windowOpen: true });
    expect(explained).toContain('different business number');
  });

  it('leaves the text alone when the window really has closed', () => {
    // Here Meta's wording is accurate, and annotating it would train agents to
    // ignore the annotation.
    expect(explainDeliveryError(RE_ENGAGEMENT_CODE, META_TEXT, { windowOpen: false })).toBe(
      META_TEXT,
    );
  });

  it('does not annotate the same numbers', () => {
    expect(
      explainDeliveryError(RE_ENGAGEMENT_CODE, META_TEXT, {
        windowOpen: false,
        inboundPhoneNumberId: '838961722630554',
        sentFromPhoneNumberId: '838961722630554',
      }),
    ).toBe(META_TEXT);
  });

  it('leaves every other code untouched', () => {
    const other = '131026: Message undeliverable';
    expect(explainDeliveryError(131026, other, { windowOpen: true })).toBe(other);
    expect(explainDeliveryError(null, other, { windowOpen: true })).toBe(other);
  });
});

describe('explainAuthError', () => {
  const META_TEXT =
    'Error validating access token: Session has expired on Tuesday, 18-Aug-26 04:00:00 PDT.';

  it('names the remedy, which Meta never does', () => {
    const explained = explainAuthError(ACCESS_TOKEN_CODE, META_TEXT);

    expect(explained).toContain(META_TEXT);
    expect(explained).toContain('META_PAGE_ACCESS_TOKEN');
    expect(explained).toContain('System User token');
  });

  it('leaves every other error alone', () => {
    expect(explainAuthError(RE_ENGAGEMENT_CODE, META_TEXT)).toBe(META_TEXT);
    expect(explainAuthError(null, META_TEXT)).toBe(META_TEXT);
  });

  it('reaches the delivery path too, so a failed message blames the credential', () => {
    // An agent looking at a failed send should be told it is a token rather
    // than something they or the customer did.
    const explained = explainDeliveryError(ACCESS_TOKEN_CODE, META_TEXT, { windowOpen: true });
    expect(explained).toContain('META_PAGE_ACCESS_TOKEN');
  });

  /**
   * Three credentials, fixed in three places. Blaming the shared token for a
   * stored credential's expiry sends somebody to Render to replace a token that
   * is fine, while the one that expired can only be renewed through Meta.
   */
  it('sends a stored credential to a reconnect, and nowhere near Render', () => {
    const explained = explainAuthError(ACCESS_TOKEN_CODE, META_TEXT, { source: 'stored' });

    expect(explained).toContain(META_TEXT);
    expect(explained).toContain('reconnected through Meta');
    expect(explained).not.toContain('META_PAGE_ACCESS_TOKEN');
    expect(explained).not.toContain('environment group');
  });

  it('names the variable an account sends with, rather than the shared one', () => {
    const explained = explainAuthError(ACCESS_TOKEN_CODE, META_TEXT, {
      source: 'variable',
      tokenEnvVar: 'WHATSAPP_TOKEN_SAUDI',
    });

    expect(explained).toContain('WHATSAPP_TOKEN_SAUDI');
    expect(explained).not.toContain('META_PAGE_ACCESS_TOKEN');
  });

  it('leaves a stored credential’s other errors alone too', () => {
    expect(explainAuthError(RE_ENGAGEMENT_CODE, META_TEXT, { source: 'stored' })).toBe(META_TEXT);
  });
});
