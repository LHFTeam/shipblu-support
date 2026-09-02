import { describe, expect, it } from 'vitest';
import { bandFor, detectCategories } from './detect';
import { MAX_TEXT_LENGTH, anchored, normaliseForMatch } from './normalise';
import { UNCLASSIFIED_KEY } from './taxonomy';

/**
 * What the detector makes of real messages.
 *
 * Every Arabic string here is either lifted from the production archive or is
 * the same construction with the identifier changed. That matters: patterns
 * written against imagined phrasing match imagined messages, and Egyptian
 * colloquial writing is not what a Modern Standard Arabic dictionary suggests.
 *
 * The **negative** cases carry the precision, and they are the reason this file
 * exists. A rule that fires too often is invisible in production — it moves a
 * number on a report nobody is auditing — so the only place to catch it is here.
 */

/** Every category the detector found, ignoring order. */
function keysFor(text: string): string[] {
  return detectCategories({ bodyText: text })
    .map((hit) => hit.key)
    .sort();
}

/** The category the detector would make primary. */
function primaryFor(text: string): string | undefined {
  return detectCategories({ bodyText: text })[0]?.key;
}

describe('nothing to classify', () => {
  // These return no hits at all rather than `unclassified`: there is a
  // difference between "we could not work out what this is about" and "there is
  // nothing here", and only the first belongs in a review queue.
  it.each([
    ['a bare question mark', '؟'],
    ['a run of question marks', '؟؟؟؟؟؟'],
    ['ASCII question marks', '???'],
    ['a full stop', '.'],
    ['dots', '.....'],
    ['a lone diacritic', 'ً'],
    ['an emoji', '👍'],
    ['a two-letter word', 'لا'],
    ['empty', ''],
    ['whitespace', '   \n  '],
  ])('finds nothing in %s', (_label, text) => {
    expect(detectCategories({ bodyText: text })).toEqual([]);
  });

  it('does not throw on a lone diacritic that normalises to nothing', () => {
    expect(() => detectCategories({ bodyText: 'ً' })).not.toThrow();
    expect(normaliseForMatch('ً')).toBe('');
  });
});

describe('the negatives that carry the precision', () => {
  it('reads a reschedule that contains ولا as a reschedule, not a refusal', () => {
    // The whole reason `anchored()` exists. This is a real archive string: `لا`
    // ("no") sits inside `ولا` ("nor"), and `\b` cannot see a boundary between
    // two Arabic letters — so a naive rule for `لا` files a customer explaining
    // when they are away as somebody refusing the parcel.
    const keys = keysFor('انا مش متواجدة غدا الخميس ولا الجمعة');
    expect(keys).toContain('delivery.reschedule');
    expect(keys).not.toContain('delivery.refused');
    expect(keys).not.toContain('return.request');
  });

  it('does not read cancel out of the middle of another word', () => {
    // `الغاء` (cancellation) must not be found inside `الغائب` (the absent one).
    const keys = keysFor('المندوب الغائب مجاش من امبارح');
    expect(keys).not.toContain('return.request');
  });

  it('keeps a job application out of the commercial area', () => {
    // Both mention working with ShipBlu. One is a candidate and one is a lead,
    // and filing the first as the second inflates the pipeline.
    expect(keysFor('مساء الخير، حابة أعرف هل عندكم حاليًا فرص شغل متاحة؟')).toContain(
      'other.job_application',
    );
    expect(keysFor('مساء الخير، حابة أعرف هل عندكم حاليًا فرص شغل متاحة؟')).not.toContain(
      'commercial.contract',
    );
  });

  it('does not classify a promo as a delivery question', () => {
    // A real archive string. It contains توصيل, so every delivery rule wants it.
    // Spam is exclusive precisely so this cannot reach the driver report.
    const keys = keysFor(
      'احصل على وجبة مجانية من كنتاكي 🍗 وتصلك لباب المنزل 🍟 تحتوي على 2 باكت دجاج',
    );
    expect(keys).toEqual(['other.spam']);
  });

  it("does not classify another merchant's autoresponder as a customer asking for help", () => {
    const keys = keysFor(
      'Thank you for contacting My little one! Please let us know how we can help you.',
    );
    expect(keys).toEqual(['other.spam']);
  });

  it('does not award a category from a single bare noun', () => {
    // `المندوب` on its own is not a request. An earlier draft matched it and it
    // is the shape of rule that quietly files a fifth of the queue.
    expect(keysFor('المندوب')).toEqual([UNCLASSIFIED_KEY]);
  });

  it('reads only the first 4,000 characters', () => {
    const padding = 'ا '.repeat(MAX_TEXT_LENGTH);
    expect(normaliseForMatch(`${padding}شكوى`)).not.toContain('شكوى');
  });

  it('caps how many categories one message can claim', () => {
    const everything =
      'الشحنة تالفة وناقصة والمندوب لم يتواصل والعنوان غلط وعايز الغي والفاتورة غلط ومحتاج اكلم حد وفين شحنتي والاسعار';
    expect(detectCategories({ bodyText: everything }).length).toBeLessThanOrEqual(4);
  });

  it('does not let a repeated word reach the auto-apply band', () => {
    // One hit per rule per message. Counting occurrences would let this
    // impersonate a structured field.
    const repeated = Array(50).fill('تتبع').join(' ');
    const hit = detectCategories({ bodyText: repeated })[0];
    expect(hit?.confidence).toBeLessThan(0.9);
  });
});

describe('delivery', () => {
  it.each([
    ['فين الاوردر', 'delivery.where_is_it'],
    ['فين الشحنه', 'delivery.where_is_it'],
    ['الاوردر فين', 'delivery.where_is_it'],
    ['الاوردر موصلش', 'delivery.where_is_it'],
    ['مفيش حاجه جت', 'delivery.where_is_it'],
    ['الاوردر هيوصل امتى', 'delivery.eta_request'],
    ['الاوردر هيوصل امتي', 'delivery.eta_request'],
    ['الساعه كام هيجي', 'delivery.eta_request'],
    ['عايز اعرف الشحنة دي اتاخرت ليه', 'delivery.late'],
    ['محدش كلمني', 'delivery.no_contact'],
    ['محدش اتواصل معايا', 'delivery.no_contact'],
    ['التليفون مغلق', 'delivery.no_contact'],
    ['عايز اغير العنوان', 'delivery.address_change'],
    ['مش هستلم الشحنه', 'delivery.refused'],
  ])('reads %s as %s', (text, expected) => {
    expect(keysFor(text)).toContain(expected);
  });

  it('spells the same question two ways and gets the same answer', () => {
    // ى vs ي, which Egyptian writing uses interchangeably. Folding is what makes
    // these one rule instead of two, and this is the test that proves it.
    const a = detectCategories({ bodyText: 'الاوردر هيوصل امتى' });
    const b = detectCategories({ bodyText: 'الاوردر هيوصل امتي' });
    expect(a[0]?.key).toBe(b[0]?.key);
    expect(a[0]?.confidence).toBe(b[0]?.confidence);
  });

  it('recognises a false delivered scan from the conjunction, not either half', () => {
    const real = 'صباح الخير لو سمحت أنا طلبت الاورد ده ومكتوب في التتبع اني استلمت';
    expect(keysFor(real)).toContain('delivery.not_received_marked_delivered');
  });

  it('does not turn a plain non-delivery into an accusation of a false scan', () => {
    // The distinction the serious category depends on. "I never received it" is
    // a non-delivery; "the tracking says delivered *and* I never received it"
    // accuses a scan of being false, and only the second is
    // `not_received_marked_delivered`. Reading the bare statement as the
    // serious one manufactures a courier accusation out of a missing parcel.
    //
    // Both of these are consecutive messages from one real conversation, which
    // is the point: detection is per message and accumulates per conversation,
    // so the ticket ends up with the serious label from the message that earns
    // it while neither message is over-read on its own.
    expect(keysFor('وأنا أصلا مستلمتيش ولسه طالبه الاورد')).toEqual(['delivery.where_is_it']);
    expect(keysFor('ومكتوب في التتبع اني استلمت')).toContain(
      'delivery.not_received_marked_delivered',
    );
  });

  it('separates an access constraint from a reschedule', () => {
    // A real archive pair. The address is right and the window is wrong, which
    // is a different fix from moving the date.
    expect(keysFor('هوا الفكرة ان ده عنوان مكتب')).toContain('delivery.access_constraint');
  });
});

describe('cancellation, however it is spelled', () => {
  it.each([
    'الغي الاوردر',
    'إلغاء الشحنه',
    'الغاء الشحنة',
    'انا لغيت الاوردر',
    'كنسلت الاوردر',
    'عايز الغي الاوردر',
    'cancel the order',
  ])('reads %s as a cancellation', (text) => {
    expect(keysFor(text)).toContain('return.request');
  });

  it('collapses the spellings to one normalised form', () => {
    const forms = ['إلغاء الشحنه', 'الغاء الشحنة', 'الغاء الشحنه'];
    const normalised = new Set(forms.map(normaliseForMatch));
    expect(normalised.size).toBe(1);
  });
});

describe('the merchant side, which the bot archive contains none of', () => {
  it.each([
    ['محتاجه ال price list', 'commercial.pricing_enquiry'],
    ['محتاجه اعرف الاسعار الاول قبل التسجيل', 'commercial.pricing_enquiry'],
    ['بستفسر عن التعاقدات الجديدة', 'commercial.contract'],
    ['كنت عايز استفسر هل بتحشن منتجات قابل للكسر', 'commercial.capability'],
    ['عندنا متجر إلكتروني على Shopify وحابين نربط', 'integration.setup'],
    ['محدش جه استلم الشحنات', 'pickup.not_collected'],
    ['محتاج الفلايرز والاكياس', 'pickup.supplies'],
    ['امتى التحويل الاسبوعي', 'billing.payout'],
    ['عايز فاتورة ضريبية', 'billing.invoice'],
    ['عايز افتح حساب', 'account.signup'],
  ])('reads %s as %s', (text, expected) => {
    expect(keysFor(text)).toContain(expected);
  });

  it('keeps a prospect asking for rates out of the existing-merchant bucket', () => {
    // `commercial.pricing_enquiry` is a sales lead; `billing.pricing` is somebody
    // already on the platform asking what they pay. Counting them together is
    // what hides how many leads are being answered as support tickets.
    expect(keysFor('محتاجه اعرف الاسعار الاول قبل التسجيل')).not.toContain('billing.pricing');
  });
});

describe('service and chasing', () => {
  it.each([
    ['في رقم للتواصل', 'service.request_human'],
    ['محتاجه خدمه عملاء', 'service.request_human'],
    ['ممكن رقم المندوب', 'service.request_human'],
    ['ممكن رد', 'service.chasing'],
    ['ارجو الرد', 'service.chasing'],
    ['برجاء التواصل', 'service.chasing'],
    ['انا عندي شكوى خاصه بالطلب', 'service.complaint'],
  ])('reads %s as %s', (text, expected) => {
    expect(keysFor(text)).toContain(expected);
  });

  it('treats a bare greeting as somebody looking for a person', () => {
    // Not `unclassified`: on a channel with no menu, "السلام عليكم" and nothing
    // else means a human is expected to answer. It is graded low so it never
    // becomes the primary on a ticket that also says something substantive.
    expect(primaryFor('السلام عليكم')).toBe('service.request_human');
  });
});

describe('choosing which category leads', () => {
  it('puts the serious half of a message first', () => {
    // Both halves are real requests. One is somebody out of a parcel.
    const primary = primaryFor('العنوان مظبوط بس محدش كلمني خلاص');
    expect(primary).toBe('delivery.no_contact');
  });

  it('is stable across repeated calls', () => {
    const text = 'الشحنة تالفة وناقصة';
    const once = detectCategories({ bodyText: text }).map((h) => h.key);
    const twice = detectCategories({ bodyText: text }).map((h) => h.key);
    expect(once).toEqual(twice);
  });
});

describe('bands', () => {
  it('applies a whole-message phrase without asking', () => {
    const hit = detectCategories({ bodyText: 'فين الاوردر' })[0]!;
    expect(hit.confidence).toBe(0.9);
    expect(bandFor(hit)).toBe('auto');
  });

  it('only suggests something inferred from keywords', () => {
    const hit = detectCategories({ bodyText: 'الشحنة تالفة' })[0]!;
    expect(hit.confidence).toBeLessThan(0.9);
    expect(bandFor(hit)).toBe('suggested');
  });

  it('always writes the unclassified fallback, despite its zero confidence', () => {
    // The exception a numeric threshold would get wrong: confidence 0 is an
    // admission rather than a guess, and it is the row the review queue is
    // built on.
    const hit = detectCategories({ bodyText: 'اللي حصل ده مش كويس خالص' })[0]!;
    expect(hit.key).toBe(UNCLASSIFIED_KEY);
    expect(hit.confidence).toBe(0);
    expect(bandFor(hit)).toBe('suggested');
  });
});

describe('normalisation', () => {
  it('folds Arabic-Indic digits so a date pattern can see them', () => {
    expect(normaliseForMatch('٢٤/٨')).toBe('24/8');
  });

  it('strips diacritics before anything splits on letters', () => {
    expect(normaliseForMatch('الشِّحنة')).toBe('الشحنه');
  });

  it('collapses a run of one punctuation mark', () => {
    expect(normaliseForMatch('؟؟؟؟؟؟')).toBe('?');
    expect(normaliseForMatch('؟؟؟')).toBe('?');
  });

  it('survives an RTL paste carrying a bidi mark', () => {
    expect(normaliseForMatch('الغاء‏')).toBe(normaliseForMatch('الغاء'));
  });

  it('is idempotent', () => {
    // Load-bearing: an admin-supplied phrase is stored already normalised, so if
    // running this twice changed the answer a stored phrase would never match.
    const samples = [
      'تأكيد البيانات',
      'العنوان مظبوط',
      'تأكيد تاريخ الإستلام',
      'تكلفة الشحنة وطرق الدفع',
      'تاريخ التوصيل والتفاصيل',
      'المحاولة تمت فعلاً',
      'لم يتم التواصل معي',
      'ممكن أضيف ملاحظة',
      'إلغاء الشحنة',
      'تأكيد الإلغاء',
      'العودة لتفاصيل الشحنة',
      'Confirm Delivery Day',
      '٢٤/٨',
      '؟؟؟؟',
      'الشِّحنة',
    ];
    for (const sample of samples) {
      const once = normaliseForMatch(sample);
      expect(normaliseForMatch(once), sample).toBe(once);
    }
  });
});

describe('anchored()', () => {
  it('refuses to match inside a word in either script', () => {
    expect(anchored('لا').test('الغاء')).toBe(false);
    expect(anchored('لا').test('ولا')).toBe(false);
    expect(anchored('لا').test('لا')).toBe(true);
    expect(anchored('cancel').test('cancellation')).toBe(false);
    expect(anchored('cancel').test('please cancel')).toBe(true);
  });

  it('allows Arabic proclitics to be handled by the rule, not the anchor', () => {
    // `anchored` is strict on purpose; giving a word its real boundaries back is
    // `ar()`'s job in rules.ts. This documents the division.
    expect(anchored('اوردر').test('والاوردر')).toBe(false);
    expect(anchored('(?:[وفبلك]?(?:ال)?)اوردر').test('والاوردر')).toBe(true);
  });
});
