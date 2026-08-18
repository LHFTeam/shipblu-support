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
