import { describe, expect, it } from 'vitest';
import { topicArt } from './art';

describe('topicArt', () => {
  it('draws the two audiences production actually has, in both languages', () => {
    expect(topicArt('ShipBlu Partners', 'shipblu-partners')).toBe('store');
    expect(topicArt('شركاء شيب بلو', 'شركاء-شيب-بلو')).toBe('store');
    expect(topicArt('ShipBlu Customers', 'shipblu-customers')).toBe('shipping');
    expect(topicArt('عملاء شيب بلو', 'عملاء-شيب-بلو')).toBe('shipping');
  });

  it('draws the subjects the design was drawn for', () => {
    expect(topicArt('Getting started')).toBe('store');
    expect(topicArt('Shipments & tracking')).toBe('shipping');
    expect(topicArt('Pickups & deliveries')).toBe('pickups');
    expect(topicArt('Returns & exchanges')).toBe('returns');
    expect(topicArt('Payments & settlement')).toBe('payments');
    expect(topicArt('Lost, damaged & claims')).toBe('claims');
  });

  it("reads production's folders, where Arabic attaches the article to the noun", () => {
    expect(topicArt('Financials', 'financials')).toBe('payments');
    expect(topicArt('الماليات', 'الماليات')).toBe('payments');
    expect(topicArt('Shipping Services', 'shipping-services')).toBe('shipping');
    expect(topicArt('خدمات الشحن', 'خدمات-الشحن')).toBe('shipping');
    expect(topicArt('Integrations', 'integrations')).toBe('store');
    expect(topicArt('أدوات الربط', 'أدوات-الربط')).toBe('store');
  });

  it('prefers the particular subject over the general one', () => {
    expect(topicArt('Lost shipments')).toBe('claims');
    expect(topicArt('Return shipments')).toBe('returns');
    expect(topicArt('COD settlement for shipments')).toBe('payments');
    expect(topicArt('Failed delivery claims')).toBe('claims');
  });

  it('draws nothing for a name it does not recognise', () => {
    expect(topicArt('FAQs', 'faqs')).toBeNull();
    expect(topicArt('الأسئلة الشائعة', 'الأسئلة-الشائعة')).toBeNull();
    expect(topicArt('Barcode labels')).toBeNull();
    expect(topicArt('')).toBeNull();
  });
});
