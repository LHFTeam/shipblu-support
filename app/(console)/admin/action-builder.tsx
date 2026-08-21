'use client';

import { useState } from 'react';
import { Select } from '@/components/ui';

/**
 * Builds the `actions` array an automation rule performs.
 *
 * The action set is closed on the server — every one is something an agent
 * could have done by hand — so this offers exactly those and nothing else. An
 * admin cannot write an action the engine will silently skip, which is the
 * failure mode of a free-text JSON field.
 */

export type Choice = { value: string; label: string };

type ActionKind =
  | 'set_priority'
  | 'set_status'
  | 'assign_agent'
  | 'assign_group'
  | 'auto_assign'
  | 'add_tags'
  | 'remove_tags'
  | 'add_watchers'
  | 'mark_spam'
  | 'send_reply';

const KINDS: { value: ActionKind; label: string }[] = [
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_status', label: 'Set status' },
  { value: 'assign_agent', label: 'Assign to agent' },
  { value: 'assign_group', label: 'Assign to group' },
  { value: 'auto_assign', label: 'Auto-assign in group' },
  { value: 'add_tags', label: 'Add tags' },
  { value: 'remove_tags', label: 'Remove tags' },
  { value: 'add_watchers', label: 'Add watchers' },
  { value: 'mark_spam', label: 'Mark as spam' },
  { value: 'send_reply', label: 'Send a canned response' },
];

const PRIORITIES: Choice[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

/**
 * How the group should choose, when a rule wants to override its own setting.
 *
 * `group_default` is first and is what a new action gets: overriding is the rare
 * case, and a rule that pins a strategy is one more place to update the day the
 * team changes how it works.
 */
const STRATEGIES: Choice[] = [
  { value: 'group_default', label: "the group's own setting" },
  { value: 'round_robin', label: 'round robin' },
  { value: 'load_balanced', label: 'load balanced' },
];

const CATEGORIES: Choice[] = [
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

/**
 * `extra` is the second value, and only `auto_assign` has one — a group *and* a
 * strategy. Optional rather than a separate action per strategy, which would put
 * three near-identical entries in a menu whose whole point is being short.
 */
type Item = { type: ActionKind; value: string; extra?: string };

export function ActionBuilder({
  name,
  agents,
  groups,
  cannedResponses,
  initial,
}: {
  name: string;
  agents: Choice[];
  groups: Choice[];
  cannedResponses: Choice[];
  initial: unknown;
}) {
  const [items, setItems] = useState<Item[]>(fromJson(initial));

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={toJson(items)} />

      {items.map((item, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Select
            value={item.type}
            onChange={(event) =>
              update(index, { type: event.target.value as ActionKind, value: '' })
            }
            className="w-52"
          >
            {KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </Select>

          <ValueInput
            item={item}
            agents={agents}
            groups={groups}
            cannedResponses={cannedResponses}
            onChange={(value) => update(index, { ...item, value })}
            onChangeExtra={(extra) => update(index, { ...item, extra })}
          />

          <button
            type="button"
            onClick={() => setItems(items.filter((_, i) => i !== index))}
            className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            Remove
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setItems([...items, { type: 'set_priority', value: 'high' }])}
        className="self-start text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
      >
        + Add action
      </button>
    </div>
  );

  function update(index: number, item: Item) {
    setItems(items.map((existing, i) => (i === index ? item : existing)));
  }
}

function ValueInput({
  item,
  agents,
  groups,
  cannedResponses,
  onChange,
  onChangeExtra,
}: {
  item: Item;
  agents: Choice[];
  groups: Choice[];
  cannedResponses: Choice[];
  onChange: (value: string) => void;
  onChangeExtra: (value: string) => void;
}) {
  const select = (choices: Choice[], placeholder: string) => (
    <Select value={item.value} onChange={(event) => onChange(event.target.value)} className="w-56">
      <option value="">{placeholder}</option>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </Select>
  );

  switch (item.type) {
    case 'set_priority':
      return select(PRIORITIES, 'Choose a priority…');
    case 'set_status':
      return select(CATEGORIES, 'Choose a status…');
    case 'assign_agent':
      return select(agents, 'Nobody (unassign)');
    case 'assign_group':
      return select(groups, 'No group');
    case 'auto_assign':
      return (
        <>
          {select(groups, "The ticket's current group")}
          <span className="text-xs text-[var(--muted-foreground)]">using</span>
          <Select
            value={item.extra ?? 'group_default'}
            onChange={(event) => onChangeExtra(event.target.value)}
            className="w-52"
          >
            {STRATEGIES.map((strategy) => (
              <option key={strategy.value} value={strategy.value}>
                {strategy.label}
              </option>
            ))}
          </Select>
        </>
      );
    case 'send_reply':
      return select(cannedResponses, 'Choose a response…');
    case 'add_watchers':
      return select(agents, 'Choose an agent…');
    case 'mark_spam':
      return <span className="text-xs text-[var(--muted-foreground)]">No settings</span>;
    default:
      return (
        <input
          value={item.value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="tag, another tag"
          className="w-56 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
        />
      );
  }
}

function toJson(items: Item[]): string {
  const actions = items.map((item) => {
    switch (item.type) {
      case 'set_priority':
        return { type: item.type, value: item.value };
      case 'set_status':
        return { type: item.type, category: item.value };
      case 'assign_agent':
        return { type: item.type, agentId: item.value || null };
      case 'assign_group':
        return { type: item.type, groupId: item.value || null };
      case 'auto_assign':
        return {
          type: item.type,
          groupId: item.value || null,
          strategy: item.extra || 'group_default',
        };
      case 'send_reply':
        return { type: item.type, cannedResponseId: item.value };
      case 'add_watchers':
        return { type: item.type, agentIds: item.value ? [item.value] : [] };
      case 'mark_spam':
        return { type: item.type };
      default:
        return {
          type: item.type,
          tags: item.value
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        };
    }
  });

  return JSON.stringify(actions, null, 2);
}

function fromJson(input: unknown): Item[] {
  if (!Array.isArray(input)) return [];

  return input.flatMap((raw): Item[] => {
    if (!raw || typeof raw !== 'object') return [];
    const action = raw as Record<string, unknown>;
    const type = action.type as ActionKind;

    if (type === 'auto_assign') {
      return [
        {
          type,
          value: String(action.groupId ?? ''),
          extra: String(action.strategy ?? 'group_default'),
        },
      ];
    }

    const value =
      type === 'set_status'
        ? String(action.category ?? '')
        : type === 'assign_agent'
          ? String(action.agentId ?? '')
          : type === 'assign_group'
            ? String(action.groupId ?? '')
            : type === 'send_reply'
              ? String(action.cannedResponseId ?? '')
              : type === 'add_watchers'
                ? ((action.agentIds as string[] | undefined)?.[0] ?? '')
                : Array.isArray(action.tags)
                  ? (action.tags as string[]).join(', ')
                  : String(action.value ?? '');

    return [{ type, value }];
  });
}
