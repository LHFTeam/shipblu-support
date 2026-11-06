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
      defaultApp: { since: null, lostAt: null },
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
      defaultApp: { since: null, lostAt: null },
    });

    expect(state.canSend).toBe(true);
  });

  it('survives a ticket with no inbound message to read', () => {
    const state = metaThreadStateFromMessage({
      platform: 'facebook',
      connection: 'facebook_page',
      configuredAccountId: PAGE,
      lastInboundMeta: null,
      defaultApp: { since: null, lostAt: null },
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
      defaultApp: { since: null, lostAt: null },
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
    expect(state.explanation).toContain('default app');
    expect(state.explanation).not.toContain('INSTAGRAM_UNIFIED_LOGIN_TOKEN');
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

  it('refuses Unified Login too while another app owns the thread', () => {
    // The plan guessed the opposite from Meta's migration guide, and the first
    // three live Unified Login sends were refused 100/2534037 for it
    // (docs/PROJECT-STATE.md §6.108). The token is the portfolio's, but the
    // send is this app's, and Instagram's thread owner is an app.
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'unified_login',
      inboundAccountId: IG_ACCOUNT,
      configuredAccountId: IG_ACCOUNT,
      standby: true,
      inboundConnection: 'facebook_page',
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('standby');
    expect(state.route).toBe('unified_login');
    expect(state.explanation).toContain('default app');
  });

  it('offers thread control only on a Messenger thread over the Page connection', () => {
    // takeThreadControl serves the Page's edge alone, and for Instagram it would
    // address the account's node, which Meta does not document for this call.
    // Keyed on the reason, the button appeared on Unified Login standbys and
    // every press was a 500 (docs/PROJECT-STATE.md §6.111).
    expect(metaThreadState(onPage({ standby: true })).canTakeControl).toBe(true);

    const instagram = (connection: MetaThreadInput['connection']) =>
      metaThreadState({
        platform: 'instagram',
        connection,
        inboundAccountId: IG_ACCOUNT,
        configuredAccountId: IG_ACCOUNT,
        standby: true,
        inboundConnection: 'facebook_page',
      });

    // Refused on both routes a Page-labelled standby blocks, and offered on
    // neither.
    for (const connection of ['unified_login', 'facebook_page'] as const) {
      const state = instagram(connection);
      expect(state.reason).toBe('standby');
      expect(state.canTakeControl).toBe(false);
    }
  });

  it('does not offer thread control where a standby does not block the send', () => {
    // The direct connection answers past the Page's handover (§6.29), so there
    // is nothing to take.
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'instagram_login',
      inboundAccountId: IG_ACCOUNT,
      configuredAccountId: IG_ACCOUNT,
      standby: true,
      inboundConnection: 'facebook_page',
    });

    expect(state.canSend).toBe(true);
    expect(state.canTakeControl).toBe(false);
    expect(state.headline).toBeNull();
  });

  it('heads each refusal in words the chip and the notice share', () => {
    expect(metaThreadState(onPage()).headline).toBeNull();
    expect(metaThreadState(onPage({ standby: true })).headline).toBe('Another app owns this inbox');
    expect(
      metaThreadState({
        platform: 'instagram',
        connection: 'unified_login',
        inboundAccountId: IG_ACCOUNT,
        configuredAccountId: IG_ACCOUNT,
        standby: true,
        inboundConnection: 'facebook_page',
      }).headline,
    ).toBe('Another app owned this thread');
    expect(metaThreadState(onPage({ inboundAccountId: OTHER_PAGE })).headline).toBe(
      'Cannot reply from here',
    );
    expect(metaThreadState(onPage({ configuredAccountId: null })).headline).toBe(
      'Cannot reply from here',
    );
  });

  it('never offers thread control where the refusal is not thread control', () => {
    expect(metaThreadState(onPage()).canTakeControl).toBe(false);
    expect(
      metaThreadState(onPage({ inboundAccountId: OTHER_PAGE, standby: true })).canTakeControl,
    ).toBe(false);
    expect(
      metaThreadState(onPage({ configuredAccountId: null, standby: true })).canTakeControl,
    ).toBe(false);
  });

  it('does not tell an agent on a Unified Login standby to do what may be done already', () => {
    // The remedy the Page's sentence ends on — make this app the default app —
    // had been done that morning when it first reached these tickets (§6.111).
    // What the flag says is who owned the thread when the customer wrote.
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'unified_login',
      inboundAccountId: IG_ACCOUNT,
      configuredAccountId: IG_ACCOUNT,
      standby: true,
      inboundConnection: null,
    });

    expect(state.explanation).not.toContain('make this app');
    expect(state.explanation).toContain('cannot be taken from here');
    expect(state.explanation).toContain('once Meta reports that it is');
  });

  it('does not let a standby the direct connection recorded refuse a Unified Login send', () => {
    // The direct connection's flag describes graph.instagram.com's thread,
    // which is the one place the account's app ownership has not been seen
    // to reach (§6.29); nothing has shown it says anything about this route.
    const state = metaThreadState({
      platform: 'instagram',
      connection: 'unified_login',
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
      defaultApp: { since: null, lostAt: null },
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
      defaultApp: { since: null, lostAt: null },
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
      defaultApp: { since: null, lostAt: null },
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
      defaultApp: { since: null, lostAt: null },
    });

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('other_account');
  });
});

describe('the switch of default app, against a standby', () => {
  // 2026-11-05: this app became the Instagram account's default app at
  // 10:30:24 UTC, and every Instagram message before it had arrived in standby
  // (docs/PROJECT-STATE.md §6.111).
  const SWITCH = new Date('2026-11-05T10:30:24Z');

  const onUnified = (lastInboundAt: Date, since: Date | null, controlTakenAt?: Date) =>
    metaThreadStateFromMessage({
      platform: 'instagram',
      connection: 'unified_login',
      configuredAccountId: IG_ACCOUNT,
      lastInboundMeta: { accountId: IG_ACCOUNT, standby: true, connection: 'facebook_page' },
      lastInboundAt,
      controlTakenAt,
      defaultApp: { since, lostAt: null },
    });

  it('supersedes a standby from before it', () => {
    // Ticket 86324's last message, 4 November at 22:57.
    const state = onUnified(new Date('2026-11-04T22:57:23Z'), SWITCH);

    expect(state.canSend).toBe(true);
    expect(state.reason).toBe('ours');
  });

  it('still refuses on a standby from after it, and says another app took the thread', () => {
    const state = onUnified(new Date('2026-11-20T09:00:00Z'), SWITCH);

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('standby');
    expect(state.canTakeControl).toBe(false);
    expect(state.explanation).toContain('after it became so');
    expect(state.explanation).not.toContain('make this app');
  });

  it('reads a standby from the second the switch is stamped with as before it', () => {
    // Meta stamps app_roles to the second and a message to the millisecond, so
    // a standby 400 ms after the stamp may well predate the switch itself.
    expect(onUnified(SWITCH, SWITCH).canSend).toBe(true);
    expect(onUnified(new Date(SWITCH.getTime() + 400), SWITCH).canSend).toBe(true);

    // A full second later it is after it, and worded so.
    const after = onUnified(new Date(SWITCH.getTime() + 1_000), SWITCH);
    expect(after.canSend).toBe(false);
    expect(after.explanation).toContain('after it became so');
  });

  it('is one of two newer facts, and either is enough', () => {
    const before = new Date('2026-11-04T22:57:23Z');

    expect(onUnified(before, null).canSend).toBe(false);
    expect(onUnified(before, null, new Date('2026-11-05T09:00:00Z')).canSend).toBe(true);
    expect(onUnified(before, SWITCH, new Date('2026-11-04T09:00:00Z')).canSend).toBe(true);
  });
});

describe('the switch, on a message from another account', () => {
  // The switch was read for the account this deployment sends from, so it says
  // nothing about another: that message is refused as other_account, and the
  // refusal must still say the other account is in standby too.
  it('leaves the other account in standby', () => {
    const state = metaThreadStateFromMessage({
      platform: 'instagram',
      connection: 'unified_login',
      configuredAccountId: IG_ACCOUNT,
      lastInboundMeta: {
        accountId: '17840000000000000',
        standby: true,
        connection: 'facebook_page',
      },
      lastInboundAt: new Date('2026-11-04T22:57:23Z'),
      defaultApp: { since: new Date('2026-11-05T10:30:24Z'), lostAt: null },
    });

    expect(state.reason).toBe('other_account');
    expect(state.explanation).toContain('standby');
  });
});

describe("Messenger's standby sentence", () => {
  it('sends the agent to the other tool or the button, not to a setting that moved nothing', () => {
    const state = metaThreadState(onPage({ standby: true }));

    expect(state.explanation).toContain('take thread control');
    expect(state.explanation).not.toContain('or make this app');
    // One deployment's history stays in the comment, not in every Page's words.
    expect(state.explanation).not.toContain('2026');
  });
});

describe('a switch of default app away from this app', () => {
  // The reading that lets a switch to this app supersede an older standby says a
  // switch away hands the thread to the new default; a reply then is refused
  // 2534037 and lands failed on the timeline.
  const LOST = new Date('2026-12-01T09:00:00Z');

  const instagram = (
    lastInboundAt: Date,
    connection: MetaThreadInput['connection'] = 'unified_login',
    accountId = IG_ACCOUNT,
  ) =>
    metaThreadStateFromMessage({
      platform: 'instagram',
      connection,
      configuredAccountId: IG_ACCOUNT,
      lastInboundMeta: { accountId, connection: 'facebook_page' },
      lastInboundAt,
      defaultApp: { since: null, lostAt: LOST },
    });

  it('refuses a thread whose customer last wrote before it', () => {
    const state = instagram(new Date('2026-11-30T12:00:00Z'));

    expect(state.canSend).toBe(false);
    expect(state.reason).toBe('standby');
    expect(state.canTakeControl).toBe(false);
    expect(state.headline).toBe('Another app owns this thread');
    expect(state.explanation).toContain("became this Instagram account's default app after");
  });

  it('leaves a thread the customer wrote on afterwards, as this app’s', () => {
    expect(instagram(new Date('2026-12-02T12:00:00Z')).canSend).toBe(true);
  });

  it('leaves the direct connection alone, which answers past the default', () => {
    expect(instagram(new Date('2026-11-30T12:00:00Z'), 'instagram_login').canSend).toBe(true);
  });

  it('says nothing about a message on another account', () => {
    expect(
      instagram(new Date('2026-11-30T12:00:00Z'), 'unified_login', '17840000000000000').reason,
    ).toBe('other_account');
  });
});
