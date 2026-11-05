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
    expect(topicArt('Pickups & deliveries')).toBe('account');
    expect(topicArt('Returns & exchanges')).toBe('returns');
    expect(topicArt('Payments & settlement')).toBe('payments');
    expect(topicArt('Lost, damaged & claims')).toBe('claims');
  });

  it("draws every one of production's folders, in both languages", () => {
    // ShipBlu Partners: six folders, six different drawings, as the design's
    // six cards have.
    const partners = [
      [topicArt('FAQs', 'faqs'), topicArt('الأسئلة الشائعة', 'الأسئلة-الشائعة'), 'questions'],
      [topicArt('Financials', 'financials'), topicArt('الماليات', 'الماليات'), 'payments'],
      [topicArt('Integrations', 'integrations'), topicArt('أدوات الربط', 'أدوات-الربط'), 'store'],
      [
        topicArt('Policies and Regulations', 'policies-and-regulations'),
        topicArt('السياسات واللوائح', 'السياسات-واللوائح'),
        'claims',
      ],
      [
        topicArt('ShipBlu Unique Products', 'shipblu-unique-products'),
        topicArt('منتجات شيب بلو المميزة', 'منتجات-شيب-بلو-المميزة'),
        'account',
      ],
      [
        topicArt('Shipping Services', 'shipping-services'),
        topicArt('خدمات الشحن', 'خدمات-الشحن'),
        'shipping',
      ],
    ] as const;
    for (const [english, arabic, expected] of partners) {
      expect(english).toBe(expected);
      expect(arabic).toBe(expected);
    }
    expect(new Set(partners.map(([, , art]) => art)).size).toBe(6);

    // ShipBlu Customers: its FAQs and the myBlu app.
    expect(topicArt('myBlu Support', 'myblu-support')).toBe('account');
    expect(topicArt('دعم تطبيق ماي بلو', 'دعم-تطبيق-ماي-بلو')).toBe('account');
  });

  it('prefers the particular subject over the general one', () => {
    expect(topicArt('Lost shipments')).toBe('claims');
    expect(topicArt('Return shipments')).toBe('returns');
    expect(topicArt('COD settlement for shipments')).toBe('payments');
    expect(topicArt('Failed delivery claims')).toBe('claims');
  });

  it('only matches a keyword that starts a word', () => {
    expect(topicArt('طرق دفع مختلفة')).not.toBe('claims');
    expect(topicArt('إجمالي الرسوم')).toBeNull();
    expect(topicArt('Carton sizes')).toBeNull();
    expect(topicArt('Disclaimer')).toBeNull();
    expect(topicArt('Restore a deleted label')).toBeNull();
    expect(topicArt('Accountability')).toBeNull();
    expect(topicArt('Apply a discount')).toBeNull();
    expect(topicArt('Police reports')).toBe('claims');
  });

  it('still reads the stems Arabic attaches its article and prepositions to', () => {
    expect(topicArt('بالشحن')).toBe('shipping');
    expect(topicArt('للتجار')).toBe('store');
    expect(topicArt('والمرتجعات')).toBe('returns');
    expect(topicArt('Accounts')).toBe('account');
    expect(topicArt('RTO shipments')).toBe('returns');
  });

  it('reads a subject before the general word that comes with it', () => {
    expect(topicArt('Shipping FAQs')).toBe('shipping');
    expect(topicArt('أسئلة الدفع والتحويل')).toBe('payments');
    // A policy is about its subject first.
    expect(topicArt('Return policy', 'return-policy')).toBe('returns');
    expect(topicArt('Shipping policy', 'shipping-policy')).toBe('shipping');
    expect(topicArt('سياسة الإرجاع', 'سياسة-الإرجاع')).toBe('returns');
    expect(topicArt('سياسة الشحن', 'سياسة-الشحن')).toBe('shipping');
    // An app that connects a store is an integration.
    expect(topicArt('Apps & Integrations')).toBe('store');
    // What cannot be shipped is a rule, whatever the products are.
    expect(topicArt('Prohibited products')).toBe('claims');
    expect(topicArt('المنتجات الممنوع شحنها')).toBe('claims');
  });

  it('draws nothing for a name it does not recognise', () => {
    expect(topicArt('Barcode labels')).toBeNull();
    expect(topicArt('Miscellaneous')).toBeNull();
    expect(topicArt('')).toBeNull();
  });
});
