import { describe, expect, it } from 'vitest';
import { metaThreadState, metaThreadStateFromMessage } from './thread';

const PAGE = '955333171001884';
const OTHER_PAGE = '101449698657189';

describe('metaThreadState', () => {
  it('lets a reply go out on the configured page', () => {
    const state = metaThreadState({
      platform: 'facebook',
      inboundAccountId: PAGE,
      configuredAccountId: PAGE,
      standby: false,
    });

    expect(state.canSend).toBe(true);
    expect(state.reason).toBe('ours');
    expect(state.explanation).toBeNull();
  });

  it('refuses a page-scoped id that belongs to another page', () => {
    const state = metaThreadState({
      platform: 'facebook',
      inboundAccountId: OTHER_PAGE,
      configuredAccountId: PAGE,
      standby: false,
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('other_account');
    // Both ids, because the fix is to change one of them and the agent
    // reporting it should not have to go and look them up.
    expect(state.explanation).toContain(OTHER_PAGE);
    expect(state.explanation).toContain(PAGE);
    expect(state.explanation).toContain('FACEBOOK_PAGE_ID');
  });

  it('names the Instagram variable when the account is an Instagram one', () => {
    const state = metaThreadState({
      platform: 'instagram',
      inboundAccountId: '17841480067102672',
      configuredAccountId: '17800000000000000',
      standby: false,
    });

    expect(state.reason).toBe('other_account');
    expect(state.explanation).toContain('INSTAGRAM_ACCOUNT_ID');
  });

  it('refuses a thread another app holds control of', () => {
    const state = metaThreadState({
      platform: 'facebook',
      inboundAccountId: PAGE,
      configuredAccountId: PAGE,
      standby: true,
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('standby');
    expect(state.explanation).toContain('thread control');
  });

  /*
    The page mismatch is reported first on purpose. Both were true of the ticket
    that produced this module: a page connected to the app after the fact, whose
    inbox another tool already owned. Naming standby first would send whoever
    reads it to negotiate a handover for a page the deployment could not have
    addressed even after winning it.
  */
  it('reports the wrong page before the handover when both are true', () => {
    const state = metaThreadState({
      platform: 'facebook',
      inboundAccountId: OTHER_PAGE,
      configuredAccountId: PAGE,
      standby: true,
    });

    expect(state.reason).toBe('other_account');
    // …and still says the second half, so repointing the id is not attempted
    // on the strength of half an explanation.
    expect(state.explanation).toContain('standby');
  });

  it('does not mention the handover when only the page is wrong', () => {
    const state = metaThreadState({
      platform: 'facebook',
      inboundAccountId: OTHER_PAGE,
      configuredAccountId: PAGE,
      standby: false,
    });

    expect(state.explanation).not.toContain('standby');
  });

  it('says so when nothing is configured to send from', () => {
    const state = metaThreadState({
      platform: 'facebook',
      inboundAccountId: PAGE,
      configuredAccountId: null,
      standby: false,
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('not_configured');
  });

  // A comment ticket has no `accountId` on its messages, and a DM ingested
  // before the field existed has none either. Neither is evidence of a wrong
  // page, so neither may block a reply.
  it('does not refuse when the inbound account is unknown', () => {
    const state = metaThreadState({
      platform: 'facebook',
      inboundAccountId: null,
      configuredAccountId: PAGE,
      standby: false,
    });

    expect(state.canSend).toBe(true);
  });
});

describe('metaThreadStateFromMessage', () => {
  it('reads the page and the handover flag off the last inbound message', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      configuredAccountId: PAGE,
      lastInboundMeta: { accountId: OTHER_PAGE, standby: true, metaKind: 'direct_message' },
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('other_account');
  });

  it('treats a row written before the flag existed as answerable', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      configuredAccountId: PAGE,
      lastInboundMeta: { accountId: PAGE, metaKind: 'direct_message' },
    });

    expect(state.canSend).toBe(true);
  });

  it('survives a ticket with no inbound message to read', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      configuredAccountId: PAGE,
      lastInboundMeta: null,
    });

    expect(state.canSend).toBe(true);
  });

  // `standby` arrives from a jsonb column, so anything could be in it.
  it('only a true flag means standby', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      configuredAccountId: PAGE,
      lastInboundMeta: { accountId: PAGE, standby: 'yes' },
    });

    expect(state.canSend).toBe(true);
  });
});
