import { describe, expect, it } from 'vitest';
import { placementsOf } from './queries';

/**
 * Which forms place which field: the answer the delete refusal and the field
 * editor's Active hint both give, so a form that would stop asking a question
 * is named before it does.
 */

const form = (slug: string, nameEn: string, elements: unknown[]) => ({
  slug,
  nameEn,
  nameAr: '',
  elements,
});

describe('placementsOf', () => {
  it('names every form that places a field, once each', () => {
    const placed = placementsOf([
      form('damaged', 'Damaged parcel', [
        { kind: 'field', key: 'order_ref' },
        { kind: 'heading', text: 'About you' },
        { kind: 'field', key: 'order_ref', required: true },
      ]),
      form('cod', 'COD question', [{ kind: 'field', key: 'order_ref' }, { kind: 'builtin' }]),
      form('other', 'Something else', [{ kind: 'field', key: 'reason' }]),
    ]);

    expect(placed.get('order_ref')).toEqual(['Damaged parcel', 'COD question']);
    expect(placed.get('reason')).toEqual(['Something else']);
    expect(placed.get('missing')).toBeUndefined();
  });

  // The admin meant to place it, whatever else the element says.
  it('counts an element the renderer would reject, and skips what is not an element', () => {
    const placed = placementsOf([
      form('odd', 'Odd form', [null, 'field', { kind: 'field', key: 'order_ref', label: 7 }]),
    ]);

    expect(placed.get('order_ref')).toEqual(['Odd form']);
  });
});
