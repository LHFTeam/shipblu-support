import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  formatForInput,
  isBlank,
  listLabels,
  missingRequired,
  type TicketFieldDef,
} from './custom-fields';
import { applyFieldValue, parseFieldValue } from './custom-fields-parse';

function field(overrides: Partial<TicketFieldDef> & { type: TicketFieldDef['type'] }) {
  return {
    key: 'test_field',
    label: 'Test field',
    options: [],
    requiredOnCreate: false,
    requiredOnResolve: false,
    visibleToCustomer: false,
    editableByCustomer: false,
    ...overrides,
  } satisfies TicketFieldDef;
}

describe('parseFieldValue', () => {
  it('stores a number as a number, so a comparison orders it', () => {
    // The bug this guards: "12" > "5" is false as strings, so a rule reading
    // "refund over 5" would skip every ticket between 10 and 99.
    const parsed = parseFieldValue(field({ type: 'decimal' }), '12.5');
    expect(parsed).toEqual({ ok: true, value: 12.5 });
  });

  it('refuses a fraction where the field is a whole number', () => {
    const parsed = parseFieldValue(field({ type: 'number' }), '2.5');
    expect(parsed.ok).toBe(false);
  });

  it('refuses text that is not a number at all', () => {
    expect(parseFieldValue(field({ type: 'number' }), 'soon').ok).toBe(false);
    expect(parseFieldValue(field({ type: 'decimal' }), 'Infinity').ok).toBe(false);
  });

  it('reads an unchecked box as no rather than as unanswered', () => {
    expect(parseFieldValue(field({ type: 'checkbox' }), '')).toEqual({ ok: true, value: false });
    expect(parseFieldValue(field({ type: 'checkbox' }), 'on')).toEqual({ ok: true, value: true });
  });

  it('refuses a dropdown value that is not one of the options', () => {
    const def = field({
      type: 'dropdown',
      options: [
        { value: 'cai', label: 'Cairo' },
        { value: 'alx', label: 'Alexandria' },
      ],
    });

    expect(parseFieldValue(def, 'cai')).toEqual({ ok: true, value: 'cai' });
    expect(parseFieldValue(def, 'Cairo').ok).toBe(false);
  });

  it('stores a multi-select in the option order, not the order they were ticked', () => {
    // Two agents picking the same two options must leave the same array, or an
    // `eq` against a stored list is decided by which box they clicked first.
    const def = field({
      type: 'multi_select',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
    });

    expect(parseFieldValue(def, ['c', 'a'])).toEqual({ ok: true, value: ['a', 'c'] });
    expect(parseFieldValue(def, ['a', 'c'])).toEqual({ ok: true, value: ['a', 'c'] });
  });

  it('de-duplicates a repeated selection', () => {
    const def = field({ type: 'multi_select', options: [{ value: 'a', label: 'A' }] });
    expect(parseFieldValue(def, ['a', 'a'])).toEqual({ ok: true, value: ['a'] });
  });

  it('keeps a date as the calendar date it is', () => {
    // Not converted to an instant: giving the 30th a midnight and a zone is how
    // it becomes the 29th for a reader on a different offset.
    expect(parseFieldValue(field({ type: 'date' }), '2026-08-30')).toEqual({
      ok: true,
      value: '2026-08-30',
    });
    expect(parseFieldValue(field({ type: 'date' }), '30/08/2026').ok).toBe(false);
  });

  it('resolves a datetime through the Cairo timezone rather than a fixed offset', () => {
    const summer = parseFieldValue(field({ type: 'datetime' }), '2026-08-30T14:00');
    const winter = parseFieldValue(field({ type: 'datetime' }), '2026-12-30T14:00');

    // Cairo observes DST again, so the same wall clock is a different instant in
    // August and in December. Hand-adding a constant +02:00 gets one of them wrong.
    expect(summer.ok && DateTime.fromISO(String(summer.value)).toUTC().hour).toBe(11);
    expect(winter.ok && DateTime.fromISO(String(winter.value)).toUTC().hour).toBe(12);
  });

  it('refuses a datetime it cannot read', () => {
    expect(parseFieldValue(field({ type: 'datetime' }), 'tomorrow').ok).toBe(false);
  });

  it('caps a text field so one ticket cannot carry a document', () => {
    expect(parseFieldValue(field({ type: 'text' }), 'x'.repeat(501)).ok).toBe(false);
    expect(parseFieldValue(field({ type: 'text' }), 'x'.repeat(500)).ok).toBe(true);
  });
});

describe('formatForInput', () => {
  it('renders a stored instant back as Cairo wall clock, in both halves of the year', () => {
    // The round trip an agent sees: what they typed is what the control shows
    // again, rather than the UTC the database holds. Both seasons, because this
    // direction goes through Intl rather than luxon — an offset hard-coded
    // either side of the wire would pass one of these and fail the other.
    const def = field({ type: 'datetime' });

    for (const entered of ['2026-08-30T14:00', '2026-12-30T14:00']) {
      const stored = parseFieldValue(def, entered);
      expect(stored.ok && formatForInput(def, stored.value)).toBe(entered);
    }
  });

  it('reads an instant stored as UTC, which is not how this writes them', () => {
    // A future importer writing `...Z` must still render as Cairo rather than as
    // the two or three hours earlier a naive slice of the string would show.
    expect(formatForInput(field({ type: 'datetime' }), '2026-08-30T11:00:00.000Z')).toBe(
      '2026-08-30T14:00',
    );
  });

  it('survives a stored value it cannot read', () => {
    expect(formatForInput(field({ type: 'datetime' }), 'not a time')).toBe('');
    expect(formatForInput(field({ type: 'text' }), null)).toBe('');
  });
});

describe('isBlank', () => {
  it('gives the same answer the condition language gives', () => {
    // Mirrors `isEmpty` in lib/rules/conditions.ts on purpose: a ticket must not
    // be able to read as complete on the form and empty to a rule.
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('   ')).toBe(true);
    expect(isBlank([])).toBe(true);

    expect(isBlank(0)).toBe(false);
    expect(isBlank(false)).toBe(false);
    expect(isBlank(['a'])).toBe(false);
  });
});

describe('applyFieldValue', () => {
  it('deletes the key when the value is cleared', () => {
    const def = field({ key: 'warehouse', type: 'text' });
    const result = applyFieldValue({ warehouse: 'CAI-1', other: 1 }, def, '  ');

    expect(result).toEqual({ ok: true, values: { other: 1 } });
  });

  it('keeps a zero and a false, which are answers rather than blanks', () => {
    const zero = applyFieldValue({}, field({ key: 'refund', type: 'decimal' }), '0');
    const no = applyFieldValue({}, field({ key: 'repeat', type: 'checkbox' }), '');

    expect(zero).toEqual({ ok: true, values: { refund: 0 } });
    expect(no).toEqual({ ok: true, values: { repeat: false } });
  });

  it('leaves the other fields alone', () => {
    const result = applyFieldValue({ a: 1 }, field({ key: 'b', type: 'text' }), 'set');
    expect(result).toEqual({ ok: true, values: { a: 1, b: 'set' } });
  });

  it('does not write anything when the value is refused', () => {
    const result = applyFieldValue({ a: 1 }, field({ key: 'b', type: 'number' }), 'nope');
    expect(result.ok).toBe(false);
  });
});

describe('missingRequired', () => {
  const onCreate = field({
    key: 'order_no',
    label: 'Order number',
    type: 'text',
    requiredOnCreate: true,
  });
  const onResolve = field({
    key: 'cause',
    label: 'Root cause',
    type: 'text',
    requiredOnResolve: true,
  });
  const optional = field({ key: 'note', label: 'Note', type: 'text' });

  it('only checks the gate being asked about', () => {
    const defs = [onCreate, onResolve, optional];

    expect(missingRequired(defs, {}, 'create')).toEqual([onCreate]);
    expect(missingRequired(defs, {}, 'resolve')).toEqual([onResolve]);
  });

  it('is satisfied by a value and not by whitespace', () => {
    expect(missingRequired([onResolve], { cause: 'damaged in transit' }, 'resolve')).toEqual([]);
    expect(missingRequired([onResolve], { cause: '  ' }, 'resolve')).toEqual([onResolve]);
  });

  it('counts an unticked required checkbox as answered', () => {
    // "No" is an answer. A box that must be ticked is a consent control, which
    // is a different feature from a required field.
    const box = field({ key: 'checked', type: 'checkbox', requiredOnResolve: true });
    expect(missingRequired([box], { checked: false }, 'resolve')).toEqual([]);
    expect(missingRequired([box], {}, 'resolve')).toEqual([box]);
  });
});

describe('listLabels', () => {
  it('reads as a sentence', () => {
    expect(listLabels([])).toBe('');
    expect(listLabels([field({ label: 'One', type: 'text' })])).toBe('One');
    expect(
      listLabels([
        field({ label: 'One', type: 'text' }),
        field({ label: 'Two', type: 'text' }),
        field({ label: 'Three', type: 'text' }),
      ]),
    ).toBe('One, Two and Three');
  });
});
