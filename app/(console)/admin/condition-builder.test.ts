import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ConditionBuilder,
  rowForField,
  shownChoices,
  shownOperators,
  valueForOperator,
  type FieldOption,
} from './condition-builder';

const fields: FieldOption[] = [
  {
    value: 'priority',
    label: 'Priority',
    kind: 'choice',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
      { value: 'urgent', label: 'Urgent' },
    ],
  },
  {
    value: 'status',
    label: 'Status category',
    kind: 'choice',
    choices: [
      { value: 'open', label: 'Open' },
      { value: 'closed', label: 'Closed' },
    ],
  },
  { value: 'subject', label: 'Subject', kind: 'text' },
  {
    value: 'group.id',
    label: 'Group',
    kind: 'choice',
    choices: [
      { value: '0861a48b-8bd8-4ea0-b288-54460a63deee', label: 'Customer Care' },
      { value: 'b080b5d9-4237-45f3-a514-a6a8bc88e604', label: 'Merchant Care' },
    ],
  },
];

describe('ConditionBuilder', () => {
  it('renders list operators as multi-select choices', () => {
    const html = renderToStaticMarkup(
      createElement(ConditionBuilder, {
        name: 'conditions',
        fields,
        initial: { field: 'priority', op: 'in', value: ['high', 'urgent'] },
      }),
    );

    expect(html).toContain('role="group" aria-label="Priority options"');
    expect(inputFor(html, 'high')).toContain('checked=""');
    expect(inputFor(html, 'urgent')).toContain('checked=""');
    expect(inputFor(html, 'low')).not.toContain('checked=""');
  });

  it('keeps scalar choice operators as a dropdown', () => {
    const html = renderToStaticMarkup(
      createElement(ConditionBuilder, {
        name: 'conditions',
        fields,
        initial: { field: 'priority', op: 'eq', value: 'high' },
      }),
    );

    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('<option value="high" selected="">High</option>');
  });

  // A set stored against a scalar operator reaches the builder from the JSON
  // editor, which does not police the pairing. Rendering every member into the
  // text box while serialising only the first is the failure that loses a term
  // without anybody touching it.
  it('serialises a scalar operator from the whole text it displays', () => {
    const html = renderToStaticMarkup(
      createElement(ConditionBuilder, {
        name: 'conditions',
        fields,
        initial: { field: 'subject', op: 'contains', value: ['refund', 'chargeback'] },
      }),
    );

    expect(hiddenValue(html)).toContain('&quot;refund, chargeback&quot;');
    expect(html).toContain('value="refund, chargeback"');
  });

  it('collapses a set to a real option when a choice field turns scalar', () => {
    // Not 'high, urgent': that matches no <option>, so the dropdown would show
    // one thing and the saved condition another.
    expect(valueForOperator(['high', 'urgent'], 'eq', fields[0]!)).toBe('high');
  });

  it('keeps every typed term when a free-text field turns scalar', () => {
    expect(valueForOperator(['refund', 'chargeback'], 'contains', fields[2]!)).toBe(
      'refund, chargeback',
    );
  });

  // The members of a set belong to the field they were picked on. The new
  // field renders checkboxes only for its own choices, so a leftover member is
  // one the builder cannot show and the admin cannot untick — while `toJson`
  // goes on writing it into the saved rule.
  it("drops the previous field's members when the field changes", () => {
    const row = rowForField(
      { field: 'priority', op: 'in', value: ['high', 'urgent'] },
      'status',
      fields,
    );

    expect(row.field).toBe('status');
    expect(row.op).toBe('in');
    expect(row.value).toEqual([]);
  });

  it('falls back to an operator the new field supports', () => {
    const row = rowForField(
      { field: 'subject', op: 'contains', value: 'refund' },
      'priority',
      fields,
    );

    // `contains` is text-only; a choice row displaying it is one its own
    // dropdown does not list, so nothing could correct it.
    expect(row.op).not.toBe('contains');
    expect(['eq', 'ne', 'in', 'not_in', 'is_set', 'is_empty']).toContain(row.op);
    expect(row.value).toBe('low');
  });

  // Production's SLA policies were written while `group.id` was free text, and
  // hold group names. Once it is a choice, a name matches no option: the
  // dropdown would show "Choose…" over it and the save would write it back,
  // still never matching. Shown as "Unknown", it is visible and replaceable.
  it('shows a stored value that is not a choice, rather than hiding it', () => {
    const html = renderToStaticMarkup(
      createElement(ConditionBuilder, {
        name: 'conditions',
        fields,
        initial: { field: 'group.id', op: 'eq', value: 'Merchant Care' },
      }),
    );

    expect(html).toContain(
      '<option value="Merchant Care" selected="">Unknown: Merchant Care</option>',
    );
    expect(html).toContain('>Merchant Care</option>');
  });

  it('gives a stale member of a set a checkbox it can be unticked from', () => {
    const html = renderToStaticMarkup(
      createElement(ConditionBuilder, {
        name: 'conditions',
        fields,
        initial: {
          field: 'group.id',
          op: 'in',
          value: ['Customer Care', '0861a48b-8bd8-4ea0-b288-54460a63deee'],
        },
      }),
    );

    expect(inputFor(html, 'Customer Care')).toContain('checked=""');
    expect(html).toContain('Unknown: Customer Care');
    expect(inputFor(html, '0861a48b-8bd8-4ea0-b288-54460a63deee')).toContain('checked=""');
  });

  // The same policies could hold `group.id does not contain …`, an operator a
  // choice field does not offer. Left off the list, the select would draw "is"
  // over it and every save would write the hidden one back.
  it('shows a stored operator the field does not offer, selected', () => {
    const html = renderToStaticMarkup(
      createElement(ConditionBuilder, {
        name: 'conditions',
        fields,
        initial: { field: 'group.id', op: 'not_contains', value: 'Merchant' },
      }),
    );

    expect(html).toContain(
      '<option value="not_contains" selected="">does not contain (not offered here)</option>',
    );
    expect(html).toContain('<option value="eq">is</option>');
    expect(hiddenValue(html)).toContain('not_contains');
  });

  it('adds no operator when the field offers the one held', () => {
    const group = fields[3]!;
    const offered = shownOperators(group, { field: 'group.id', op: 'eq', value: '' });
    expect(offered.map((op) => op.value)).toEqual([
      'eq',
      'ne',
      'in',
      'not_in',
      'is_set',
      'is_empty',
    ]);
  });

  it('adds nothing when every held value is a choice', () => {
    const group = fields[3]!;
    expect(
      shownChoices(group, {
        field: 'group.id',
        op: 'eq',
        value: '0861a48b-8bd8-4ea0-b288-54460a63deee',
      }),
    ).toEqual(group.choices);
    expect(shownChoices(group, { field: 'group.id', op: 'eq', value: '' })).toEqual(group.choices);
  });
});

function hiddenValue(html: string): string {
  return html.match(/<input type="hidden" name="conditions" value="([^"]*)"/)?.[1] ?? '';
}

function inputFor(html: string, value: string): string {
  return html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0] ?? '';
}
