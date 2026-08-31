import { describe, expect, it } from 'vitest';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import { elementsFor, isRequired, parseFormElements, type FieldElement } from './elements';

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

const DEFS = [def('order_number'), def('reason')];

describe('parseFormElements', () => {
  it('drops an element naming a field that no longer exists', () => {
    // The trap this guards: an admin deactivates "Warehouse" and three
    // published forms start throwing rather than quietly asking one question
    // fewer. Same answer the condition language gives a rule pointing at a
    // deleted field.
    const parsed = parseFormElements(
      [
        { kind: 'field', key: 'order_number' },
        { kind: 'field', key: 'warehouse' },
      ],
      DEFS,
    );

    expect(parsed.map((element) => (element as FieldElement).key)).toEqual(['order_number']);
  });

  it('keeps only the first element for a repeated field', () => {
    // Two inputs writing one key store one answer, and the customer cannot see
    // which of the two was kept.
    const parsed = parseFormElements(
      [
        { kind: 'field', key: 'reason', labelEn: 'First' },
        { kind: 'field', key: 'reason', labelEn: 'Second' },
      ],
      DEFS,
    );

    expect(parsed).toHaveLength(1);
    expect((parsed[0] as FieldElement).labelEn).toBe('First');
  });

  it('drops an element whose visibility will not parse', () => {
    // "Does not match" is what a malformed condition means everywhere else, and
    // on a form that has to mean "not asked" — never "asked unconditionally".
    const parsed = parseFormElements(
      [{ kind: 'field', key: 'reason', visibility: { field: 'custom.x', op: 'nonsense' } }],
      DEFS,
    );

    expect(parsed).toEqual([]);
  });

  it('drops an unknown system key rather than rendering an input for it', () => {
    const parsed = parseFormElements(
      [
        { kind: 'system', key: 'subject' },
        { kind: 'system', key: 'assignee' },
      ],
      DEFS,
    );

    expect(parsed).toHaveLength(1);
  });

  it('drops a heading with neither language written', () => {
    const parsed = parseFormElements(
      [
        { kind: 'heading', textAr: '', textEn: '' },
        { kind: 'heading', textAr: 'التفاصيل', textEn: '' },
      ],
      DEFS,
    );

    expect(parsed).toHaveLength(1);
  });

  it('normalises blank overrides to null so the renderer has one empty case', () => {
    const parsed = parseFormElements(
      [{ kind: 'field', key: 'reason', labelEn: '   ', helpAr: 'لماذا؟', required: 'yes' }],
      DEFS,
    );

    expect(parsed[0]).toMatchObject({
      labelEn: null,
      helpAr: 'لماذا؟',
      // Not the string 'yes' — only a real boolean overrides the inherited answer.
      required: null,
    });
  });

  it('treats a missing visibility as always shown', () => {
    const parsed = parseFormElements([{ kind: 'field', key: 'reason' }], DEFS);
    expect(parsed[0]!.visibility).toEqual({});
  });

  it('returns nothing for a document that is not a list', () => {
    expect(parseFormElements({ kind: 'field', key: 'reason' }, DEFS)).toEqual([]);
    expect(parseFormElements(null, DEFS)).toEqual([]);
  });
});

describe('isRequired', () => {
  it('lets a form demand a field that is optional elsewhere', () => {
    const [element] = parseFormElements([{ kind: 'field', key: 'reason', required: true }], DEFS);
    expect(isRequired(element as FieldElement, def('reason'))).toBe(true);
  });

  it('inherits the field when the form has no opinion', () => {
    const [element] = parseFormElements([{ kind: 'field', key: 'reason' }], DEFS);
    expect(isRequired(element as FieldElement, def('reason', { requiredOnCreate: true }))).toBe(
      true,
    );
    expect(isRequired(element as FieldElement, def('reason'))).toBe(false);
  });

  it('lets a form waive a field that is required elsewhere', () => {
    const [element] = parseFormElements([{ kind: 'field', key: 'reason', required: false }], DEFS);
    expect(isRequired(element as FieldElement, def('reason', { requiredOnCreate: true }))).toBe(
      false,
    );
  });
});

describe('elementsFor', () => {
  const defs = [
    def('order_number'),
    def('root_cause', { visibleToCustomer: false, editableByCustomer: false }),
    def('read_only', { visibleToCustomer: true, editableByCustomer: false }),
  ];

  const placed = parseFormElements(
    [
      { kind: 'system', key: 'requester_email' },
      { kind: 'system', key: 'priority' },
      { kind: 'field', key: 'order_number' },
      { kind: 'field', key: 'root_cause' },
      { kind: 'field', key: 'read_only' },
    ],
    defs,
  );

  function keysFor(audience: 'customer' | 'agent', anonymous: boolean): string[] {
    return elementsFor(placed, { audience, anonymous }, defs).map(
      (element) => (element as FieldElement).key,
    );
  }

  it('does not publish an internal field because a form placed it', () => {
    // The whole point of visible_to_customer. Placing "Root cause" on a public
    // form would otherwise put an internal question on the help centre, and the
    // admin who placed it would have no way to tell from the builder.
    expect(keysFor('customer', true)).not.toContain('root_cause');
    // Readable but not writable is the same answer: there is nothing to show on
    // a ticket that does not exist yet.
    expect(keysFor('customer', true)).not.toContain('read_only');
  });

  it('asks an agent everything the form places', () => {
    // The flags were never about them — an agent already reads and writes every
    // field from the sidebar.
    expect(keysFor('agent', false)).toContain('root_cause');
    expect(keysFor('agent', false)).toContain('read_only');
  });

  it('asks for an email only when nobody is signed in', () => {
    expect(keysFor('customer', true)).toContain('requester_email');
    // A signed-in customer retyping their address is a typo away from filing
    // the ticket against somebody else.
    expect(keysFor('customer', false)).not.toContain('requester_email');
    expect(keysFor('agent', false)).not.toContain('requester_email');
  });

  it('keeps priority to agents', () => {
    // Customers grading their own urgency is a queue that is entirely urgent.
    expect(keysFor('customer', true)).not.toContain('priority');
    expect(keysFor('agent', false)).toContain('priority');
  });
});
