import { describe, expect, it } from 'vitest';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import { parseFormElements, type FieldElement } from './elements';
import { resolveVisibility } from './visibility';

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

const DEFS = [def('problem'), def('damage_kind'), def('photo_note'), def('other_detail')];

/** A → B → C: each answer reveals the next question. */
const CHAINED = parseFormElements(
  [
    { kind: 'field', key: 'problem' },
    {
      kind: 'field',
      key: 'damage_kind',
      visibility: { field: 'custom.problem', op: 'eq', value: 'damaged' },
    },
    {
      kind: 'field',
      key: 'photo_note',
      visibility: { field: 'custom.damage_kind', op: 'eq', value: 'crushed' },
    },
  ],
  DEFS,
);

function keys(elements: { kind: string }[]): string[] {
  return elements.map((element) => (element as FieldElement).key);
}

describe('resolveVisibility', () => {
  it('follows a chain of conditions to the end', () => {
    // One pass would stop at damage_kind: photo_note is revealed by an answer
    // that only becomes visible once problem has been read.
    const resolved = resolveVisibility(CHAINED, { problem: 'damaged', damage_kind: 'crushed' }, {});

    expect(keys(resolved.visible)).toEqual(['problem', 'damage_kind', 'photo_note']);
    expect(resolved.custom).toEqual({ problem: 'damaged', damage_kind: 'crushed' });
  });

  it('stops the chain where the answers stop justifying it', () => {
    const resolved = resolveVisibility(CHAINED, { problem: 'late' }, {});
    expect(keys(resolved.visible)).toEqual(['problem']);
  });

  it('discards an answer to a question the form never asked', () => {
    // The crafted POST. `damage_kind` is not shown for a late parcel, so a
    // hand-made request answering it must not reach `custom_fields` — an
    // automation routing on `custom.damage_kind` would otherwise be steerable by
    // anybody who could read the page source.
    const resolved = resolveVisibility(CHAINED, { problem: 'late', damage_kind: 'crushed' }, {});

    expect(resolved.custom).toEqual({ problem: 'late' });
    expect(keys(resolved.visible)).toEqual(['problem']);
  });

  it('does not let a discarded answer reveal the next question either', () => {
    // The same attack one step further along: answering both hidden questions
    // must not walk the chain open from the middle.
    const resolved = resolveVisibility(
      CHAINED,
      { problem: 'late', damage_kind: 'crushed', photo_note: 'here' },
      {},
    );

    expect(resolved.custom).toEqual({ problem: 'late' });
    expect(keys(resolved.visible)).toEqual(['problem']);
  });

  it('reads a system answer as a fact under its bare name', () => {
    const elements = parseFormElements(
      [
        { kind: 'system', key: 'subject' },
        {
          kind: 'field',
          key: 'other_detail',
          visibility: { field: 'subject', op: 'contains', value: 'refund' },
        },
      ],
      DEFS,
    );

    const shown = resolveVisibility(elements, {}, { subject: 'A refund please' });
    expect(shown.visible).toHaveLength(2);

    const hidden = resolveVisibility(elements, {}, { subject: 'Where is my parcel' });
    expect(hidden.visible).toHaveLength(1);
  });

  it('settles rather than spinning on two conditions that contradict each other', () => {
    // Nonsense configuration, but an admin can write it and it must not hang the
    // request: each question is shown only while the other is unanswered.
    const elements = parseFormElements(
      [
        {
          kind: 'field',
          key: 'problem',
          visibility: { field: 'custom.damage_kind', op: 'is_empty' },
        },
        {
          kind: 'field',
          key: 'damage_kind',
          visibility: { field: 'custom.problem', op: 'is_empty' },
        },
      ],
      DEFS,
    );

    const resolved = resolveVisibility(elements, { problem: 'a', damage_kind: 'b' }, {});
    expect(resolved.visible.length).toBeLessThanOrEqual(2);
  });

  it('keeps a heading conditional on the same terms as a field', () => {
    const elements = parseFormElements(
      [
        { kind: 'field', key: 'problem' },
        {
          kind: 'heading',
          textEn: 'About the damage',
          textAr: '',
          visibility: { field: 'custom.problem', op: 'eq', value: 'damaged' },
        },
      ],
      DEFS,
    );

    expect(resolveVisibility(elements, { problem: 'damaged' }, {}).visible).toHaveLength(2);
    expect(resolveVisibility(elements, { problem: 'late' }, {}).visible).toHaveLength(1);
  });
});
