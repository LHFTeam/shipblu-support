import { describe, expect, it } from 'vitest';
import { categoryWord, shownLabel } from './status-words';

describe('categoryWord', () => {
  it('gives each category its word in the reader’s language', () => {
    expect(categoryWord('pending', 'en')).toBe('In progress');
    expect(categoryWord('pending', 'ar')).toBe('قيد المعالجة');
  });

  // The value comes off the database enum, which a deploy can widen before
  // this list knows the new value; a throw there takes down the customer's
  // whole list of tickets, where the raw value only reads oddly.
  it('reads a category it does not know as itself rather than throwing', () => {
    expect(categoryWord('on_hold', 'ar')).toBe('on_hold');
  });
});

describe('shownLabel', () => {
  it('sends the label only while the status is shown, and never the name', () => {
    expect(shownLabel({ visibleToCustomer: true, customerLabel: 'Being checked' })).toBe(
      'Being checked',
    );
    expect(shownLabel({ visibleToCustomer: false, customerLabel: 'Being checked' })).toBeNull();
    expect(shownLabel({ visibleToCustomer: true, customerLabel: null })).toBeNull();
  });
});
