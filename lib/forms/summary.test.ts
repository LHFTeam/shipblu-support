import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import { parseFormElements } from './elements';
import { answerText, renderAnswers } from './summary';

function def(key: string, overrides: Partial<TicketFieldDef> = {}): TicketFieldDef {
  return {
    key,
    label: key,
    labelAr: null,
    labelEn: null,
    type: 'text',
    options: [],
    validation: null,
    requiredOnCreate: false,
    requiredOnResolve: false,
    visibleToCustomer: true,
    editableByCustomer: true,
    ...overrides,
  };
}

const PAYMENT = def('payment', {
  label: 'Payment',
  labelAr: 'طريقة الدفع',
  type: 'dropdown',
  options: [
    { value: 'cod', label: 'Cash on delivery', labelAr: 'الدفع عند الاستلام' },
    { value: 'prepaid', label: 'Prepaid', labelAr: 'مدفوع مسبقًا' },
  ],
});

describe('answerText', () => {
  it('reads back a choice as its label, not the value a rule compares', () => {
    // "Payment: cod" makes an agent go and look up what cod meant.
    expect(answerText(PAYMENT, 'cod', 'en')).toBe('Cash on delivery');
    expect(answerText(PAYMENT, 'cod', 'ar')).toBe('الدفع عند الاستلام');
  });

  it('falls back to the one label that was written', () => {
    const partial = def('x', { type: 'dropdown', options: [{ value: 'a', label: 'A' }] });
    expect(answerText(partial, 'a', 'ar')).toBe('A');
  });

  it('lists a multi-select in the field’s own option order', () => {
    const kinds = def('kinds', {
      type: 'multi_select',
      options: [
        { value: 'torn', label: 'Torn' },
        { value: 'wet', label: 'Wet' },
        { value: 'crushed', label: 'Crushed' },
      ],
    });

    expect(answerText(kinds, ['crushed', 'torn'], 'en')).toBe('Torn, Crushed');
  });

  it('renders an unticked box as an answer rather than a blank', () => {
    const box = def('fragile', { type: 'checkbox' });
    expect(answerText(box, false, 'en')).toBe('No');
    expect(answerText(box, true, 'ar')).toBe('نعم');
  });

  it('leaves a calendar date alone rather than putting it through a Date', () => {
    // `new Date('2026-08-29')` is midnight UTC, which is 02:00 in Cairo and the
    // day before further west. The 30th has to stay the 30th.
    expect(answerText(def('when', { type: 'date' }), '2026-08-29', 'en')).toBe('2026-08-29');
  });

  it('reads a datetime back as the Cairo wall clock somebody entered', () => {
    const summer = DateTime.fromObject(
      { year: 2026, month: 8, day: 29, hour: 14, minute: 30 },
      { zone: 'Africa/Cairo' },
    );
    const winter = DateTime.fromObject(
      { year: 2026, month: 1, day: 15, hour: 14, minute: 30 },
      { zone: 'Africa/Cairo' },
    );

    const field = def('slot', { type: 'datetime' });

    // Cairo observes DST again, so the offset is not a constant to add — both
    // sides of the changeover have to come back as 14:30.
    expect(answerText(field, summer.toISO(), 'en')).toBe('2026-08-29 14:30');
    expect(answerText(field, winter.toISO(), 'en')).toBe('2026-01-15 14:30');
  });
});

describe('renderAnswers', () => {
  const defs = [PAYMENT, def('note', { label: 'Note' }), def('fragile', { type: 'checkbox' })];

  const elements = parseFormElements(
    [
      { kind: 'system', key: 'description' },
      { kind: 'field', key: 'payment' },
      { kind: 'field', key: 'note', labelEn: 'Anything else' },
      { kind: 'field', key: 'fragile' },
    ],
    defs,
  );

  it('follows the order the customer was asked, and uses the form’s own wording', () => {
    const rendered = renderAnswers(
      elements,
      defs,
      { note: 'Left at the gate', payment: 'prepaid', fragile: false },
      'en',
    );

    expect(rendered).toBe('Payment: Prepaid\nAnything else: Left at the gate\nfragile: No');
  });

  it('leaves out a question that was not answered', () => {
    // A wall of "Label: —" hides the two lines that were filled in.
    expect(renderAnswers(elements, defs, { payment: 'cod' }, 'en')).toBe(
      'Payment: Cash on delivery',
    );
  });

  it('cannot print an answer to a question the form does not ask', () => {
    // A key left in `custom_fields` by an earlier form, or by an agent editing
    // the sidebar, is not part of this submission's story.
    expect(renderAnswers(elements, defs, { warehouse: 'Cairo 6' }, 'en')).toBe('');
  });
});
