import { describe, expect, it } from 'vitest';
import { metaThreadState, type MetaThreadInput, metaThreadStateFromMessage } from './thread';

const PAGE = '955333171001884';
const OTHER_PAGE = '101449698657189';
const IG_ACCOUNT = '17841448759001625';

/**
 * The Page connection, which is what every case here was written against and
 * what a deployment without `INSTAGRAM_ACCESS_TOKEN` still has. The cases about
 * the direct connection name it explicitly.
 */
function onPage(overrides: Partial<MetaThreadInput> = {}): MetaThreadInput {
  return {
    platform: 'facebook',
    connection: 'facebook_page',
    inboundAccountId: PAGE,
    configuredAccountId: PAGE,
    standby: false,
    inboundConnection: 'facebook_page',
    ...overrides,
  };
}

describe('metaThreadState', () => {
  it('lets a reply go out on the configured page', () => {
    const state = metaThreadState(onPage());

    expect(state.canSend).toBe(true);
    expect(state.reason).toBe('ours');
    expect(state.explanation).toBeNull();
  });

  it('refuses a page-scoped id that belongs to another page', () => {
    const state = metaThreadState(onPage({ inboundAccountId: OTHER_PAGE }));

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('other_account');
    // Both ids, because the fix is to change one of them and the agent
    // reporting it should not have to go and look them up.
    expect(state.explanation).toContain(OTHER_PAGE);
    expect(state.explanation).toContain(PAGE);
    expect(state.explanation).toContain('FACEBOOK_PAGE_ID');
  });

  it('names the Instagram variable when the account is an Instagram one', () => {
    const state = metaThreadState(
      onPage({
        platform: 'instagram',
        inboundAccountId: '17841480067102672',
        configuredAccountId: '17800000000000000',
      }),
    );

    expect(state.reason).toBe('other_account');
    expect(state.explanation).toContain('INSTAGRAM_ACCOUNT_ID');
  });

  it('refuses a thread another app holds control of', () => {
    const state = metaThreadState(onPage({ standby: true }));

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
    const state = metaThreadState(onPage({ inboundAccountId: OTHER_PAGE, standby: true }));

    expect(state.reason).toBe('other_account');
    // …and still says the second half, so repointing the id is not attempted
    // on the strength of half an explanation.
    expect(state.explanation).toContain('standby');
  });

  it('does not mention the handover when only the page is wrong', () => {
    const state = metaThreadState(onPage({ inboundAccountId: OTHER_PAGE }));

    expect(state.explanation).not.toContain('standby');
  });

  it('says so when nothing is configured to send from', () => {
    const state = metaThreadState(onPage({ configuredAccountId: null }));

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('not_configured');
  });

  // A comment ticket has no `accountId` on its messages, and a DM ingested
  // before the field existed has none either. Neither is evidence of a wrong
  // page, so neither may block a reply.
  it('does not refuse when the inbound account is unknown', () => {
    const state = metaThreadState(onPage({ inboundAccountId: null }));

    expect(state.canSend).toBe(true);
  });
});

describe('metaThreadStateFromMessage', () => {
  it('reads the page and the handover flag off the last inbound message', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      connection: 'facebook_page',
      configuredAccountId: PAGE,
      lastInboundMeta: { accountId: OTHER_PAGE, standby: true, metaKind: 'direct_message' },
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('other_account');
  });

  it('treats a row written before the flag existed as answerable', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      connection: 'facebook_page',
      configuredAccountId: PAGE,
      lastInboundMeta: { accountId: PAGE, metaKind: 'direct_message' },
    });

    expect(state.canSend).toBe(true);
  });

  it('survives a ticket with no inbound message to read', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      connection: 'facebook_page',
      configuredAccountId: PAGE,
      lastInboundMeta: null,
    });

    expect(state.canSend).toBe(true);
  });

  // `standby` arrives from a jsonb column, so anything could be in it.
  it('only a true flag means standby', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      connection: 'facebook_page',
      configuredAccountId: PAGE,
      lastInboundMeta: { accountId: PAGE, standby: 'yes' },
    });

    expect(state.canSend).toBe(true);
  });
});

describe('metaThreadState across the two Instagram connections', () => {
  /*
    The bug this exists to prevent, and it was live for two days.

    Freshworks is the primary receiver on the ShipBlu Page, so every Instagram
    delivery reaching this app through the Page arrives in `standby`. That is a
    fact about the Page's inbox. A reply sent through Instagram Login goes out
    with the account's own token against graph.instagram.com, where the Page's
    handover has no standing at all — but the flag was read as a property of the
    account, so the console refused every Instagram reply on the strength of it
    (docs/PROJECT-STATE.md §6.29).
  */
  it('lets the direct connection answer a thread the Page does not control', () => {
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'instagram_login',
      inboundAccountId: IG_ACCOUNT,
      configuredAccountId: IG_ACCOUNT,
      standby: true,
      inboundConnection: 'facebook_page',
    });

    expect(state.canSend).toBe(true);
    expect(state.route).toBe('instagram_login');
  });

  it('still refuses when the Page connection is the only route', () => {
    // The same ticket on a deployment with no Instagram token: nothing has
    // changed for it, and it must not start claiming it can answer.
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'facebook_page',
      inboundAccountId: IG_ACCOUNT,
      configuredAccountId: IG_ACCOUNT,
      standby: true,
      inboundConnection: 'facebook_page',
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('standby');
    // The way out is named, because it is a configuration change rather than a
    // negotiation with whoever owns the Page inbox.
    expect(state.explanation).toContain('INSTAGRAM_ACCESS_TOKEN');
  });

  it("reads a standby with no connection recorded as the Page's", () => {
    // Every row written before the column existed. Those deliveries all came
    // through the Page, so the flag on them describes the Page.
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'facebook_page',
      inboundAccountId: IG_ACCOUNT,
      configuredAccountId: IG_ACCOUNT,
      standby: true,
      inboundConnection: null,
    });

    expect(state.canSend).toBe(false);
  });

  it('does not carry a standby from one connection over to the other', () => {
    // A flag recorded by the direct connection says nothing about the Page's
    // thread control, and guessing "blocked" there would refuse a send that
    // would have worked.
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'facebook_page',
      inboundAccountId: IG_ACCOUNT,
      configuredAccountId: IG_ACCOUNT,
      standby: true,
      inboundConnection: 'instagram_login',
    });

    expect(state.canSend).toBe(true);
  });

  it('reports the route it would send over', () => {
    expect(metaThreadState(onPage()).route).toBe('facebook_page');
  });
});

describe('metaThreadStateFromMessage and the connection on the row', () => {
  it('reads the connection off the message', () => {
    const state = metaThreadStateFromMessage({
      platform: 'instagram',
      connection: 'instagram_login',
      configuredAccountId: IG_ACCOUNT,
      lastInboundMeta: {
        accountId: IG_ACCOUNT,
        standby: true,
        connection: 'facebook_page',
        metaKind: 'direct_message',
      },
    });

    expect(state.canSend).toBe(true);
  });

  it('ignores anything in the column that is not a connection', () => {
    // jsonb, so it could hold anything at all.
    const state = metaThreadStateFromMessage({
      platform: 'instagram',
      connection: 'facebook_page',
      configuredAccountId: IG_ACCOUNT,
      lastInboundMeta: { accountId: IG_ACCOUNT, standby: true, connection: 'whatsapp' },
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('standby');
  });
});

/*
  The rule that lets the console's "take thread control" button mean anything.

  `standby` on a message is a permanent fact about that message and is never
  rewritten, so the *only* thing that can reopen a ticket after a handover is
  this comparison. Getting it backwards fails in the two worst ways available:
  a composer that never reopens, or one that invites a reply Graph will refuse.
*/
describe('metaThreadStateFromMessage and control taken since', () => {
  const inbound = { accountId: PAGE, standby: true, metaKind: 'direct_message' };

  function withControl(controlTakenAt: Date | null, lastInboundAt: Date | null) {
    return metaThreadStateFromMessage({
      platform: 'facebook',
      connection: 'facebook_page',
      configuredAccountId: PAGE,
      lastInboundMeta: inbound,
      lastInboundAt,
      controlTakenAt,
    });
  }

  it('answers a thread taken after the message arrived', () => {
    const state = withControl(new Date('2026-09-06T18:52:00Z'), new Date('2026-09-06T18:48:16Z'));

    expect(state.canSend).toBe(true);
    expect(state.reason).toBe('ours');
  });

  it('refuses again when a newer message arrived in standby', () => {
    // Control moves back silently — the other tool can take the thread at any
    // time — and a message landing in `standby` afterwards is the only notice
    // of it we get. Without this the console would keep offering a reply that
    // Graph refuses, on the strength of a handover that has since been undone.
    const state = withControl(new Date('2026-09-06T18:52:00Z'), new Date('2026-09-06T19:10:00Z'));

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('standby');
  });

  it('treats an exact tie as not held', () => {
    // The two instants come off different clocks — Meta's `sentAt` and ours —
    // so a tie is not evidence. The message is the fact we were given; control
    // is the one we inferred.
    const at = new Date('2026-09-06T18:48:16Z');

    expect(withControl(at, at).canSend).toBe(false);
  });

  it('leaves a ticket that has never been taken exactly as it was', () => {
    expect(withControl(null, new Date('2026-09-06T18:48:16Z')).canSend).toBe(false);
  });

  it('does not let control rescue a message from another page', () => {
    // A different refusal with a different remedy: the recipient's id does not
    // exist on the page we send from, and no amount of thread control changes
    // that.
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      connection: 'facebook_page',
      configuredAccountId: PAGE,
      lastInboundMeta: { accountId: OTHER_PAGE, standby: true, metaKind: 'direct_message' },
      lastInboundAt: new Date('2026-09-06T18:48:16Z'),
      controlTakenAt: new Date('2026-09-06T18:52:00Z'),
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('other_account');
  });
});
