import { describe, expect, it } from 'vitest';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import { parseFormElements, type FieldElement } from './elements';
import { renderSubject } from './subject';

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

const DEFS = [
  def('tracking_number'),
  def('city', {
    type: 'dropdown',
    options: [{ value: 'cairo', label: 'Cairo', labelAr: 'القاهرة' }],
  }),
];

const PLACED = parseFormElements(
  [
    { kind: 'system', key: 'subject' },
    { kind: 'field', key: 'tracking_number' },
    { kind: 'field', key: 'city' },
  ],
  DEFS,
).filter((element): element is FieldElement => element.kind === 'field');

function render(
  template: string | null,
  custom: Record<string, unknown>,
  system: { subject?: string } = {},
  locale: 'ar' | 'en' = 'en',
) {
  return renderSubject(template, PLACED, DEFS, custom, system, locale, 'Support request');
}

describe('renderSubject', () => {
  it('fills a placeholder from the answer', () => {
    expect(render('Damaged parcel — {{tracking_number}}', { tracking_number: 'SB123' })).toBe(
      'Damaged parcel — SB123',
    );
  });

  it('does not leave the separator dangling when the answer is missing', () => {
    // The template is written for the case where the optional field is answered;
    // "Damaged parcel — " reads as a truncated subject rather than a short one.
    expect(render('Damaged parcel — {{tracking_number}}', {})).toBe('Damaged parcel');
  });

  it('reads a choice as its label in the reader’s language', () => {
    expect(render('Pickup in {{city}}', { city: 'cairo' })).toBe('Pickup in Cairo');
    expect(render('استلام من {{city}}', { city: 'cairo' }, {}, 'ar')).toBe('استلام من القاهرة');
  });

  it('keeps Arabic intact rather than transliterating it', () => {
    expect(render('{{tracking_number}} — شكوى', { tracking_number: 'SB1' })).toBe('SB1 — شكوى');
  });

  it('lets a template use what the customer typed', () => {
    expect(render('[Damaged] {{subject}}', {}, { subject: 'Box arrived open' })).toBe(
      '[Damaged] Box arrived open',
    );
  });

  it('ignores a placeholder naming a field this form does not ask', () => {
    // Otherwise the subject would be built from an answer left in
    // `custom_fields` by some other form — a question this submission never saw.
    expect(render('Refund for {{warehouse}}', { warehouse: 'Cairo 6' })).toBe('Refund for');
  });

  it('falls back to what was typed, then to the form’s name', () => {
    expect(render(null, {}, { subject: 'Box arrived open' })).toBe('Box arrived open');
    expect(render(null, {}, {})).toBe('Support request');
    // A template that renders to nothing is the same as having none.
    expect(render('{{tracking_number}}', {}, { subject: 'Typed' })).toBe('Typed');
    expect(render('{{tracking_number}}', {}, {})).toBe('Support request');
  });

  it('caps the subject so a paragraph pasted into a field cannot become one', () => {
    const long = 'x'.repeat(400);
    expect(render('{{tracking_number}}', { tracking_number: long })).toHaveLength(200);
  });
});
