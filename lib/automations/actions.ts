/**
 * What an automation rule can do to a ticket.
 *
 * A closed set, deliberately. The alternative — a rule that can write any
 * column — turns every automation into a migration risk and makes "what could
 * possibly have changed this ticket?" unanswerable. Everything here is
 * something an agent could have done by hand, which is also what makes the
 * resulting timeline entries honest.
 */

import type { AssignmentStrategy } from '@/lib/assignment';
import {
  isPriority,
  isStatusCategory,
  type Priority,
  type StatusCategory,
} from '@/lib/tickets/vocabulary';

export type Action =
  | { type: 'set_priority'; value: Priority }
  | { type: 'set_status'; category: StatusCategory }
  | { type: 'assign_agent'; agentId: string | null }
  | { type: 'assign_group'; groupId: string | null }
  /**
   * Route into a group and let that group's rota pick the person.
   *
   * The difference from `assign_agent` is that this one names no agent: it is
   * how an admin says "urgent shipping tickets go to the shipping team, whoever
   * is free", which is a rule that stays correct when somebody leaves.
   *
   * `groupId: null` means the ticket's current group, so a rule can turn routing
   * on for a ticket without moving it. `strategy: 'group_default'` defers to the
   * group's own setting, which is the common case — an override is for the rule
   * that wants urgent work load-balanced in a group that is otherwise round
   * robin.
   */
  | {
      type: 'auto_assign';
      groupId: string | null;
      strategy: AssignmentStrategy | 'group_default';
    }
  | { type: 'add_tags'; tags: string[] }
  | { type: 'remove_tags'; tags: string[] }
  | { type: 'add_watchers'; agentIds: string[] }
  | { type: 'mark_spam' }
  | { type: 'send_reply'; cannedResponseId: string };

const STRATEGIES = new Set(['group_default', 'manual', 'round_robin', 'load_balanced']);

/**
 * Validates one stored action.
 *
 * Returns null for anything unrecognised rather than throwing: a rule written
 * against an action this deploy does not know about should skip that action and
 * still perform the rest, which is what makes a rolled-back deploy survivable.
 */
export function parseAction(input: unknown): Action | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const node = input as Record<string, unknown>;

  switch (node.type) {
    case 'set_priority':
      return isPriority(node.value) ? { type: 'set_priority', value: node.value } : null;

    case 'set_status':
      return isStatusCategory(node.category)
        ? { type: 'set_status', category: node.category }
        : null;

    case 'assign_agent':
      return { type: 'assign_agent', agentId: asIdOrNull(node.agentId) };

    case 'assign_group':
      return { type: 'assign_group', groupId: asIdOrNull(node.groupId) };

    case 'auto_assign': {
      // An unrecognised strategy rejects the whole action rather than quietly
      // falling back to the group default: a rule written against a strategy
      // this deploy does not know about should be skipped, not reinterpreted
      // into something the admin did not ask for.
      const strategy = typeof node.strategy === 'string' ? node.strategy : 'group_default';
      if (!STRATEGIES.has(strategy)) return null;
      return {
        type: 'auto_assign',
        groupId: asIdOrNull(node.groupId),
        strategy: strategy as AssignmentStrategy | 'group_default',
      };
    }

    case 'add_tags':
    case 'remove_tags': {
      const tags = asStringList(node.tags);
      return tags.length ? { type: node.type, tags } : null;
    }

    case 'add_watchers': {
      const agentIds = asStringList(node.agentIds);
      return agentIds.length ? { type: 'add_watchers', agentIds } : null;
    }

    case 'mark_spam':
      return { type: 'mark_spam' };

    case 'send_reply':
      return typeof node.cannedResponseId === 'string' && node.cannedResponseId
        ? { type: 'send_reply', cannedResponseId: node.cannedResponseId }
        : null;

    default:
      return null;
  }
}

export function parseActions(input: unknown): Action[] {
  if (!Array.isArray(input)) return [];
  return input.map(parseAction).filter((action): action is Action => action !== null);
}

function asIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}
