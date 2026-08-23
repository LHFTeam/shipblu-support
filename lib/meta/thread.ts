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
};

export type MetaThreadInput = {
  platform: MetaPlatform;
  /** The page or Instagram account the customer's message arrived on. */
  inboundAccountId: string | null;
  /** The account this deployment is configured to send from. */
  configuredAccountId: string | null;
  /**
   * The customer's last message arrived in the handover protocol's `standby`
   * array, so another app holds thread control.
   */
  standby: boolean;
};

const OURS: MetaThreadState = { canSend: true, reason: 'ours', explanation: null };

export function metaThreadState(input: MetaThreadInput): MetaThreadState {
  const product = input.platform === 'instagram' ? 'Instagram' : 'Messenger';

  if (!input.configuredAccountId) {
    return {
      canSend: false,
      reason: 'not_configured',
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
  */
  if (input.standby) {
    return {
      canSend: false,
      reason: 'standby',
      explanation:
        `Another app holds thread control on this ${product} inbox, so this ticket is ` +
        `readable here but cannot be answered from here — ${product} accepts a reply only ` +
        `from the app that owns the thread. The messages arrive in the handover protocol's ` +
        `standby channel, which is what says so. Answer in whichever tool is the primary ` +
        `receiver, or hand thread control to this app in the Meta app's Messenger settings.`,
    };
  }

  return OURS;
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
  configuredAccountId: string | null;
  lastInboundMeta: Record<string, unknown> | null | undefined;
}): MetaThreadState {
  const meta = input.lastInboundMeta ?? {};
  const accountId = typeof meta.accountId === 'string' ? meta.accountId : null;

  return metaThreadState({
    platform: input.platform,
    inboundAccountId: accountId,
    configuredAccountId: input.configuredAccountId,
    // Absent on every row written before the flag was recorded. Those threads
    // were answerable, so a missing value must not read as "cannot send".
    standby: meta.standby === true,
  });
}
