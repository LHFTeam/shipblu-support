/**
 * What an automation rule can do to a ticket.
 *
 * A closed set, deliberately. The alternative — a rule that can write any
 * column — turns every automation into a migration risk and makes "what could
 * possibly have changed this ticket?" unanswerable. Everything here is
 * something an agent could have done by hand, which is also what makes the
 * resulting timeline entries honest.
 */

export type Action =
  | { type: 'set_priority'; value: 'low' | 'medium' | 'high' | 'urgent' }
  | { type: 'set_status'; category: 'open' | 'pending' | 'resolved' | 'closed' }
  | { type: 'assign_agent'; agentId: string | null }
  | { type: 'assign_group'; groupId: string | null }
  | { type: 'add_tags'; tags: string[] }
  | { type: 'remove_tags'; tags: string[] }
  | { type: 'add_watchers'; agentIds: string[] }
  | { type: 'mark_spam' }
  | { type: 'send_reply'; cannedResponseId: string };

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const CATEGORIES = new Set(['open', 'pending', 'resolved', 'closed']);

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
      return typeof node.value === 'string' && PRIORITIES.has(node.value)
        ? { type: 'set_priority', value: node.value as 'low' | 'medium' | 'high' | 'urgent' }
        : null;

    case 'set_status':
      return typeof node.category === 'string' && CATEGORIES.has(node.category)
        ? {
            type: 'set_status',
            category: node.category as 'open' | 'pending' | 'resolved' | 'closed',
          }
        : null;

    case 'assign_agent':
      return { type: 'assign_agent', agentId: asIdOrNull(node.agentId) };

    case 'assign_group':
      return { type: 'assign_group', groupId: asIdOrNull(node.groupId) };

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
