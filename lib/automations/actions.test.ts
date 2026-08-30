import { describe, expect, it } from 'vitest';
import { parseAction, parseActions } from './actions';

describe('parseAction', () => {
  it('accepts each supported action', () => {
    expect(parseAction({ type: 'set_priority', value: 'urgent' })).toEqual({
      type: 'set_priority',
      value: 'urgent',
    });
    expect(parseAction({ type: 'set_status', category: 'resolved' })).toEqual({
      type: 'set_status',
      category: 'resolved',
    });
    expect(parseAction({ type: 'mark_spam' })).toEqual({ type: 'mark_spam' });
    expect(parseAction({ type: 'send_reply', cannedResponseId: 'abc' })).toEqual({
      type: 'send_reply',
      cannedResponseId: 'abc',
    });
  });

  it('reads clearing an assignment as an explicit null', () => {
    // "Unassign" and "assign to nobody in particular" are the same instruction,
    // and both have to survive a round trip through jsonb.
    expect(parseAction({ type: 'assign_agent' })).toEqual({ type: 'assign_agent', agentId: null });
    expect(parseAction({ type: 'assign_agent', agentId: '  ' })).toEqual({
      type: 'assign_agent',
      agentId: null,
    });
  });

  it('rejects values outside the enum rather than writing them', () => {
    expect(parseAction({ type: 'set_priority', value: 'catastrophic' })).toBeNull();
    expect(parseAction({ type: 'set_status', category: 'archived' })).toBeNull();
  });

  it('drops empty tag and watcher lists, which would be no-ops', () => {
    expect(parseAction({ type: 'add_tags', tags: [] })).toBeNull();
    expect(parseAction({ type: 'add_tags', tags: ['  '] })).toBeNull();
    expect(parseAction({ type: 'add_watchers', agentIds: 'nobody' })).toBeNull();
  });

  it('de-duplicates and trims tags', () => {
    expect(parseAction({ type: 'add_tags', tags: [' vip ', 'vip', 'cod'] })).toEqual({
      type: 'add_tags',
      tags: ['vip', 'cod'],
    });
  });

  it('returns null for an unknown action', () => {
    expect(parseAction({ type: 'delete_everything' })).toBeNull();
    expect(parseAction('resolve it')).toBeNull();
    expect(parseAction(null)).toBeNull();
  });
});

describe('parseActions', () => {
  it('skips what it does not recognise and keeps the rest', () => {
    // A rule written against a newer deploy must still do the parts this one
    // understands, rather than failing whole.
    const actions = parseActions([
      { type: 'set_priority', value: 'high' },
      { type: 'summon_a_manager' },
      { type: 'add_tags', tags: ['escalated'] },
    ]);

    expect(actions).toEqual([
      { type: 'set_priority', value: 'high' },
      { type: 'add_tags', tags: ['escalated'] },
    ]);
  });

  it('is empty for anything that is not a list', () => {
    expect(parseActions({ type: 'set_priority', value: 'high' })).toEqual([]);
    expect(parseActions(undefined)).toEqual([]);
  });
});

describe('auto_assign', () => {
  it("defaults to the group's own strategy and the ticket's own group", () => {
    expect(parseAction({ type: 'auto_assign' })).toEqual({
      type: 'auto_assign',
      groupId: null,
      strategy: 'group_default',
    });
  });

  it('carries an explicit group and strategy', () => {
    expect(parseAction({ type: 'auto_assign', groupId: 'g1', strategy: 'load_balanced' })).toEqual({
      type: 'auto_assign',
      groupId: 'g1',
      strategy: 'load_balanced',
    });
  });

  /*
   * Rejected outright rather than falling back to the group default. A rule
   * written against a strategy this deploy does not know about should be
   * skipped — quietly reinterpreting it would route tickets somewhere the admin
   * never asked for, which is worse than the rule not running.
   */
  it('rejects a strategy it does not recognise', () => {
    expect(parseAction({ type: 'auto_assign', strategy: 'psychic' })).toBeNull();
  });

  it('survives round-tripping through parseActions with its siblings', () => {
    const actions = parseActions([
      { type: 'set_priority', value: 'urgent' },
      { type: 'auto_assign', groupId: 'g1', strategy: 'round_robin' },
    ]);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({ type: 'auto_assign', strategy: 'round_robin' });
  });
});
