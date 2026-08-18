import { describe, expect, it } from 'vitest';
import { explainDeliveryError, RE_ENGAGEMENT_CODE } from './errors';

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
