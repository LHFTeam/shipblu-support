import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ConditionBuilder,
  rowForField,
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
});

function hiddenValue(html: string): string {
  return html.match(/<input type="hidden" name="conditions" value="([^"]*)"/)?.[1] ?? '';
}

function inputFor(html: string, value: string): string {
  return html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0] ?? '';
}
