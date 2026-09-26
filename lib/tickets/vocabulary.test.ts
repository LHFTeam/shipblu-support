import { describe, expect, it } from 'vitest';
import { agentRoleEnum, priorityEnum, statusCategoryEnum } from '@/db/schema/enums';
import { isAgentRole, ROLES_BY_SENIORITY } from '@/lib/auth/permissions';
import {
  isPriority,
  isStatusCategory,
  PRIORITIES,
  PRIORITY_CHOICES,
  STATUS_CATEGORIES,
} from './vocabulary';

/**
 * The lists are copies, so that a client form can import them; these hold each
 * copy to the enum it copies. A value added to the database and not here would
 * otherwise be refused by every form and action that checks against the list —
 * silently, as "Unknown priority", for a value the column accepts.
 */
describe('the ticket vocabulary', () => {
  it('lists every priority the database has, in the order it declares them', () => {
    expect([...PRIORITIES]).toEqual(priorityEnum.enumValues);
  });

  it('lists every status category the database has', () => {
    expect([...STATUS_CATEGORIES]).toEqual(statusCategoryEnum.enumValues);
  });

  it('lists every role the database has, whatever order each uses', () => {
    // Deliberately a set comparison. The enum is declared most senior first and
    // the list most junior first; `lib/kb/internal.ts` explains why nothing may
    // lean on the enum's order.
    expect([...ROLES_BY_SENIORITY].sort()).toEqual([...agentRoleEnum.enumValues].sort());
  });

  it('offers every priority as a labelled choice, in the same order', () => {
    expect(PRIORITY_CHOICES.map((choice) => choice.value)).toEqual([...PRIORITIES]);
    expect(PRIORITY_CHOICES.every((choice) => choice.label.length > 0)).toBe(true);
  });

  it('recognises its own words and nothing else', () => {
    expect(PRIORITIES.every(isPriority)).toBe(true);
    expect(STATUS_CATEGORIES.every(isStatusCategory)).toBe(true);
    expect(ROLES_BY_SENIORITY.every(isAgentRole)).toBe(true);
    expect(isAgentRole('owner')).toBe(false);
    expect(isPriority('Urgent')).toBe(false);
    expect(isPriority('open')).toBe(false);
    expect(isStatusCategory('all')).toBe(false);
    expect(isStatusCategory(undefined)).toBe(false);
  });
});
