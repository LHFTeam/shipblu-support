import type { MetaConnection } from './connection';
import type { MetaPlatform } from './types';

/**
 * Whether a Messenger or Instagram thread is *ours to answer at all*.
 *
 * `lib/meta/window.ts` answers a different question — how long we have left —
 * and it is the one the console already asks. Both have to be true before a
 * reply can go out, and until now only the clock was checked: a ticket on a
 * page this app cannot send from looked identical to one it could, right up to
 * the moment Graph refused it.
 *
 * It refuses with `code 1, "An unknown error has occurred."` and an HTTP 500,
 * which names no rule, survives three retries unchanged, and leaves the agent
 * with a failed badge and nothing to act on. Both causes below produce exactly
 * that same sentence, so neither is diagnosable after the fact — which is why
 * they are decided here, from what the inbound message already recorded, before
 * a request is made.
 */

export type MetaThreadState = {
  /** A reply can be delivered, as far as ownership of the thread goes. */
  canSend: boolean;
  reason: 'ours' | 'standby' | 'other_account' | 'not_configured';
  /** Written for the agent reading the timeline, not for a log. */
  explanation: string | null;
  /** The connection the reply would go out over. */
  route: MetaConnection;
};

export type MetaThreadInput = {
  platform: MetaPlatform;
  /**
   * The connection a reply would go out over — `metaConnection(platform)`.
   *
   * It decides what `standby` means, which is the whole reason it is here.
   */
  connection: MetaConnection;
  /** The page or Instagram account the customer's message arrived on. */
  inboundAccountId: string | null;
  /** The account this deployment is configured to send from. */
  configuredAccountId: string | null;
  /**
   * The customer's last message arrived in the handover protocol's `standby`
   * array, so another app holds thread control.
   */
  standby: boolean;
  /**
   * The connection that message was delivered on, or null on a row written
   * before the two were told apart.
   *
   * `standby` is a fact about *one* connection, not about the account, so it
   * only rules out a send over the connection that reported it.
   */
  inboundConnection: MetaConnection | null;
};

export function metaThreadState(input: MetaThreadInput): MetaThreadState {
  const product = input.platform === 'instagram' ? 'Instagram' : 'Messenger';
  const ours: MetaThreadState = {
    canSend: true,
    reason: 'ours',
    explanation: null,
    route: input.connection,
  };

  if (!input.configuredAccountId) {
    return {
      canSend: false,
      reason: 'not_configured',
      route: input.connection,
      explanation:
        input.platform === 'instagram'
          ? 'INSTAGRAM_ACCOUNT_ID is not set, so no Instagram reply can be addressed.'
          : 'FACEBOOK_PAGE_ID is not set, so no Messenger reply can be addressed.',
    };
  }

  /*
    A page-scoped id is scoped to the page that issued it and to nothing else.

    Sending it from a different page is not a permissions failure Graph
    describes — the recipient simply does not exist over there, and the send
    API says so with its generic refusal. This is the check that would have
    caught a page being connected to the app while the deployment kept sending
    from the one it was first configured with.
  */
  if (input.inboundAccountId && input.inboundAccountId !== input.configuredAccountId) {
    return {
      canSend: false,
      reason: 'other_account',
      route: input.connection,
      explanation:
        `This ticket arrived on ${product} account ${input.inboundAccountId}, but this ` +
        `deployment sends from ${input.configuredAccountId}. The customer's id is scoped ` +
        `to the account that received the message and means nothing to another one, so ` +
        `the reply cannot be addressed. Either point ` +
        `${input.platform === 'instagram' ? 'INSTAGRAM_ACCOUNT_ID' : 'FACEBOOK_PAGE_ID'} ` +
        `at ${input.inboundAccountId} — with a token for it — or disconnect that account ` +
        `from the Meta app.` +
        // Both were true of the ticket this module was written for. Reporting
        // only the first sends whoever fixes it back for a second round, having
        // moved a production page id on the strength of an explanation that
        // turned out to be half the reason.
        (input.standby
          ? `\n\nThat account is also one this app does not hold thread control of — its ` +
            `messages arrive in the handover protocol's standby channel — so repointing ` +
            `the id alone will not be enough.`
          : ''),
    };
  }

  /*
    Standby means another app is the primary receiver for this inbox.

    We are subscribed and we see everything, which is why the ticket exists at
    all; we are not the app Meta will accept a send from. Nothing about this
    changes with a retry, a token or an approval — thread control has to be
    passed to this app, which is a decision made in the other tool.

    **But it is a fact about the Facebook Page's inbox, and only that.** The
    handover protocol belongs to the Page: an app installed on a Page receives
    `standby` when another installed app owns the thread. An Instagram
    professional account connected directly through Instagram Login is not
    installed on anything — it is authorised against the account itself, there is
    no primary receiver to be second to, and its deliveries arrive in `messaging`
    while the Page's copies of the same message arrive in `standby`. Both were
    observed for one account, seconds apart (`docs/PROJECT-STATE.md` §6.29).

    So a `standby` recorded by the Page connection must not veto a send going out
    over the direct one — which is the state this deployment has been in since 28
    August: every Instagram and Messenger delivery arriving in `standby` because
    Freshworks is the Page's primary receiver, and every Instagram reply refused
    here on the strength of it. Freshworks owning the Page inbox says nothing
    about whether Instagram will accept a message sent with the account's own
    token.

    The inbound connection is checked as well as the route, because a flag
    recorded by one connection describes that one. Null — every row written
    before the distinction existed — is read as "the Page's", which is what those
    rows were.
  */
  const standbyBlocks =
    input.standby &&
    input.connection === 'facebook_page' &&
    (input.inboundConnection === null || input.inboundConnection === 'facebook_page');

  if (standbyBlocks) {
    return {
      canSend: false,
      reason: 'standby',
      route: input.connection,
      explanation:
        `Another app holds thread control on this ${product} inbox, so this ticket is ` +
        `readable here but cannot be answered from here — ${product} accepts a reply only ` +
        `from the app that owns the thread. The messages arrive in the handover protocol's ` +
        `standby channel, which is what says so. Answer in whichever tool is the primary ` +
        `receiver, hand thread control to this app in the Meta app's Messenger settings` +
        (input.platform === 'instagram'
          ? `, or connect the account directly under Instagram → API setup with Instagram ` +
            `login and set INSTAGRAM_ACCESS_TOKEN, which routes replies around the Page ` +
            `entirely`
          : '') +
        `.`,
    };
  }

  return ours;
}

/**
 * The thread state of a ticket, from the customer's most recent message.
 *
 * Thread control moves, and it moves without telling us: the same customer can
 * be answerable today and handed to another inbox tool tomorrow. So the state
 * is read from the newest inbound message rather than from the oldest or from
 * the conversation, which carries no record of it.
 */
export function metaThreadStateFromMessage(input: {
  platform: MetaPlatform;
  connection: MetaConnection;
  configuredAccountId: string | null;
  lastInboundMeta: Record<string, unknown> | null | undefined;
  /** When that message arrived, for the comparison below. */
  lastInboundAt?: Date | null;
  /**
   * When this app last took thread control of the conversation, if it ever has.
   */
  controlTakenAt?: Date | null;
}): MetaThreadState {
  const meta = input.lastInboundMeta ?? {};
  const accountId = typeof meta.accountId === 'string' ? meta.accountId : null;

  return metaThreadState({
    platform: input.platform,
    connection: input.connection,
    inboundAccountId: accountId,
    configuredAccountId: input.configuredAccountId,
    // Absent on every row written before the flag was recorded. Those threads
    // were answerable, so a missing value must not read as "cannot send".
    standby: meta.standby === true && !holdsControl(input.controlTakenAt, input.lastInboundAt),
    inboundConnection: readConnection(meta.connection),
  });
}

/**
 * Whether the newer of the two facts is "we took control".
 *
 * `standby` on a message is a permanent, true statement about *that message*:
 * another app owned the thread when it arrived. It is not a statement about now,
 * and it stopped being a safe proxy for now the moment a button could change
 * thread control from inside the console — every ticket would keep refusing on
 * the strength of a flag from before the handover, and the only thing that could
 * clear it would be the customer writing again.
 *
 * So the verdict is whichever fact is newer, which is self-correcting in both
 * directions and needs no webhook this app does not already receive. Take
 * control and the next render unblocks. Lose it again — control moves, and only
 * ever silently — and the next inbound message arrives in `standby` with a
 * timestamp past ours, which puts the refusal straight back without anybody
 * having to notice.
 *
 * The two instants come from different clocks: a message carries Meta's `sentAt`
 * and the event carries ours. Seconds of skew are the whole error, and the
 * quantity being compared is the gap between a customer's message and an agent
 * pressing a button — minutes at the very least. A tie counts as *not* held,
 * because the message is the fact we were given and control is the one we
 * inferred.
 */
function holdsControl(
  controlTakenAt: Date | null | undefined,
  lastInboundAt: Date | null | undefined,
): boolean {
  if (!controlTakenAt) return false;
  // No inbound message to be newer than. Nothing set `standby` either, so this
  // is unreachable today; it answers "we hold it" rather than leaving the
  // comparison to decide from a null.
  if (!lastInboundAt) return true;

  return controlTakenAt.getTime() > lastInboundAt.getTime();
}

/** The connection off a message's `meta`, ignoring anything it is not. */
function readConnection(value: unknown): MetaConnection | null {
  return value === 'facebook_page' || value === 'instagram_login' ? value : null;
}
