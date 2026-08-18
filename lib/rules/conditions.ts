/**
 * The condition language shared by SLA policies and automation rules.
 *
 * One language, two callers, deliberately: `sla_policies.conditions` and
 * `automation_rules.conditions` are the same jsonb shape, so an admin who has
 * learned to express "urgent tickets from the shipping group" for an automation
 * writes the identical thing for an SLA policy. Two dialects would be two sets
 * of bugs and two help pages.
 *
 * Shape:
 *
 *   {}                                          matches everything
 *   { field: 'priority', op: 'in', value: [...] }
 *   { all: [ {...}, {...} ] }                   every branch must match
 *   { any: [ {...}, {...} ] }                   at least one branch
 *   { not: {...} }
 *
 * Nesting is arbitrary, so `all` of an `any` expresses the "match ALL / match
 * ANY" grid Freshdesk offers without being limited to it.
 */

export type FactValue = string | number | boolean | Date | string[] | null | undefined;
export type Facts = Record<string, FactValue>;

export type Operator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_set'
  | 'is_empty';

export type Comparison = { field: string; op: Operator; value?: unknown };
export type Condition =
  | Comparison
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | Record<string, never>;

const OPERATORS = new Set<Operator>([
  'eq',
  'ne',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_set',
  'is_empty',
]);

/**
 * Structural validation, kept separate from evaluation.
 *
 * Conditions arrive as untyped jsonb written by an admin form or by hand, so
 * "is this even a condition?" is a real question at read time rather than a
 * type-system one. Returning null instead of throwing lets each caller decide
 * what a malformed rule means for it — and both callers decide it means "does
 * not match", never "matches everything".
 */
export function parseCondition(input: unknown): Condition | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;

  const node = input as Record<string, unknown>;
  const keys = Object.keys(node);

  // The empty object is the "no conditions" case, which every default policy
  // and catch-all rule uses. It has to be legal and it has to match.
  if (keys.length === 0) return {};

  if ('all' in node || 'any' in node) {
    const key = 'all' in node ? 'all' : 'any';
    const branches = node[key];
    if (!Array.isArray(branches)) return null;

    const parsed: Condition[] = [];
    for (const branch of branches) {
      const child = parseCondition(branch);
      if (!child) return null;
      parsed.push(child);
    }
    return key === 'all' ? { all: parsed } : { any: parsed };
  }

  if ('not' in node) {
    const child = parseCondition(node.not);
    return child ? { not: child } : null;
  }

  if (typeof node.field !== 'string' || !node.field) return null;
  if (typeof node.op !== 'string' || !OPERATORS.has(node.op as Operator)) return null;

  return { field: node.field, op: node.op as Operator, value: node.value };
}

/**
 * Evaluates a parsed condition against a ticket's facts.
 *
 * An unknown field is absent rather than an error: rules outlive the fields
 * they were written against, and a rule referring to a deleted custom field
 * should quietly stop matching rather than break the sweep for every other
 * ticket.
 */
export function evaluate(condition: Condition, facts: Facts): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluate(child, facts));
  if ('any' in condition) return condition.any.some((child) => evaluate(child, facts));
  if ('not' in condition) return !evaluate(condition.not, facts);
  if (!('field' in condition)) return true; // {} — no conditions

  return compare(facts[condition.field], condition.op, condition.value);
}

/** Parse and evaluate in one step; malformed conditions never match. */
export function matches(rawCondition: unknown, facts: Facts): boolean {
  const parsed = parseCondition(rawCondition);
  if (!parsed) return false;
  return evaluate(parsed, facts);
}

function compare(fact: FactValue, op: Operator, value: unknown): boolean {
  switch (op) {
    case 'is_set':
      return !isEmpty(fact);
    case 'is_empty':
      return isEmpty(fact);
    case 'eq':
      return scalarEquals(fact, value);
    case 'ne':
      return !scalarEquals(fact, value);
    case 'in':
      return toArray(value).some((entry) => scalarEquals(fact, entry));
    case 'not_in':
      return !toArray(value).some((entry) => scalarEquals(fact, entry));
    case 'contains':
      return containsValue(fact, value);
    case 'not_contains':
      return !containsValue(fact, value);
    case 'starts_with':
      return text(fact).startsWith(text(value));
    case 'ends_with':
      return text(fact).endsWith(text(value));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return ordered(fact, op, value);
  }
}

function isEmpty(fact: FactValue): boolean {
  if (fact === null || fact === undefined) return true;
  if (Array.isArray(fact)) return fact.length === 0;
  if (typeof fact === 'string') return fact.trim() === '';
  return false;
}

/**
 * Scalar equality, case-insensitive for strings.
 *
 * Case sensitivity here would mean a rule written against the tag "VIP" silently
 * ignoring every ticket tagged "vip", which is indistinguishable from the rule
 * being broken.
 */
function scalarEquals(fact: FactValue, value: unknown): boolean {
  if (fact instanceof Date) return fact.getTime() === toNumber(value);
  if (typeof fact === 'string' || typeof value === 'string') {
    if (fact === null || fact === undefined) return false;
    if (Array.isArray(fact)) return false;
    return text(fact) === text(value);
  }
  return fact === value;
}

/** Membership for array facts (tags), substring for text facts. */
function containsValue(fact: FactValue, value: unknown): boolean {
  if (Array.isArray(fact)) {
    return toArray(value).some((entry) => fact.some((item) => text(item) === text(entry)));
  }
  if (fact === null || fact === undefined) return false;
  return text(fact).includes(text(value));
}

function ordered(fact: FactValue, op: 'gt' | 'gte' | 'lt' | 'lte', value: unknown): boolean {
  const left = toNumber(fact);
  const right = toNumber(value);
  if (left === null || right === null) return false;

  switch (op) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}

/**
 * Anything orderable, as a number.
 *
 * Dates become instants so "created before X" works, and the ISO-string form is
 * accepted alongside a real Date because that is what a condition stored as
 * jsonb actually contains — a rule comparing `created_at` to a date can only
 * have been written as a string. Numeric strings are read as numbers first, so
 * a value of "5" stays five rather than becoming a date in 2001.
 */
function toNumber(input: unknown): number | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.getTime();
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  if (typeof input === 'string' && input.trim() !== '') {
    const numeric = Number(input);
    if (Number.isFinite(numeric)) return numeric;

    const parsed = Date.parse(input);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim().toLowerCase();
}
