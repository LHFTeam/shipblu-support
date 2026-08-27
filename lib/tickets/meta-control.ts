import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations } from '@/db/schema';
import { env } from '@/lib/env';
import {
  fetchThreadOwner,
  isNotThreadOwner,
  MetaApiError,
  releaseThreadControl,
  requestThreadControl,
  takeThreadControl,
} from '@/lib/meta/client';
import {
  describeAppId,
  metaControlState,
  type MetaControlState,
  type ThreadOwnerReading,
} from '@/lib/meta/control';
import type { MetaPlatform } from '@/lib/meta/types';
import { metaReplyTarget, type MetaReplyTarget } from './meta-thread';

/**
 * Reading and moving thread control from the console.
 *
 * The button in the composer is one press; underneath it are three Graph calls
 * that have to agree with each other and with what the database says next.
 * They live here rather than in `app/(console)/actions.ts` so the sequencing —
 * act, re-read, persist, record — is in one place and the action stays the
 * authorise-and-revalidate shape every other action has.
 */

export type MetaControlView = {
  /** Whether a control button makes sense at all on this ticket. */
  available: boolean;
  state: MetaControlState;
  /** When the live reading was taken. Null when there was no live reading. */
  checkedAt: Date | null;
  /**
   * The live read failed and the state below is inferred from the stored
   * snapshot and the standby flag. Shown, not hidden: an agent about to take a
   * thread away from another team should know we are guessing.
   */
  stale: boolean;
  error: string | null;
};

const UNAVAILABLE: MetaControlView = {
  available: false,
  state: {
    holder: 'unknown',
    ownerAppId: null,
    expiresAt: null,
    intent: null,
    label: '',
    explanation: '',
    blockedReason: null,
  },
  checkedAt: null,
  stale: false,
  error: null,
};

/**
 * Asks Meta who owns the thread, and persists the answer when it tells us
 * something we did not already know.
 *
 * Persisting a *read* is the part worth justifying: it looks like caching and
 * is not. `conversations.metaControlCheckedAt` is what lets the send-side
 * verdict outrank a stale `standby` flag on an old inbound message, so a read
 * that stayed in the response would leave the composer refusing replies the
 * agent can plainly see are allowed. See `changesTheAnswer` for what counts.
 */
export async function readMetaControl(
  conversationId: string,
  platform: MetaPlatform,
): Promise<MetaControlView> {
  const target = await metaReplyTarget(conversationId, platform);
  if (!target.recipientId) return UNAVAILABLE;

  const ourAppId = env().META_APP_ID ?? null;
  const standby = target.thread.reason === 'standby';

  let reading: ThreadOwnerReading | null = null;
  let error: string | null = null;

  try {
    reading = await fetchThreadOwner(platform, target.recipientId);
  } catch (caught) {
    error = describeGraphFailure(caught);
    console.warn(`[meta:control] could not read the thread owner for ${conversationId}`, caught);
  }

  const checkedAt = reading ? new Date() : null;
  if (reading && checkedAt && changesTheAnswer(target, reading.appId)) {
    await storeControl(conversationId, reading.appId, checkedAt);
  }

  return {
    available: true,
    state: metaControlState({ platform, ourAppId, reading, standby }),
    checkedAt,
    stale: reading === null,
    error,
  };
}

/**
 * Whether persisting this reading would change any verdict.
 *
 * Every write to `conversations` fires the row's `pg_notify`, which refreshes
 * the ticket for everyone looking at it — and this read runs each time an agent
 * opens a Facebook or Instagram ticket. Confirming what is already stored is
 * the overwhelmingly common case and has nothing to tell anybody, so it writes
 * nothing.
 *
 * Advancing the timestamp alone is not a no-op, though, which is why the second
 * clause is here. A snapshot older than the customer's last message loses to
 * that message's `standby` flag; a reading taken now beats it. Skipping the
 * write on the grounds that the app id matched would leave the composer
 * refusing a reply the reading has just shown to be allowed.
 */
function changesTheAnswer(target: MetaReplyTarget, appId: string | null): boolean {
  const stored = target.control;
  if (!stored.checkedAt) return true;
  if (stored.appId !== appId) return true;

  return target.lastInboundAt !== null && stored.checkedAt < target.lastInboundAt;
}

export type MetaControlOutcome = {
  /**
   * `taken` and `released` are done. `requested` is not: Meta's request flow
   * asks the current owner to hand over, and the owner may ignore it. Reporting
   * it as a transfer would have the agent typing a reply that gets refused.
   */
  result: 'taken' | 'released' | 'requested';
  /** Where control ended up, as far as a confirming re-read could tell. */
  view: MetaControlView;
};

/**
 * Moves thread control, then re-reads to find out whether it moved.
 *
 * The re-read is not belt and braces. `take_thread_control` answers
 * `{"success": true}` for the request having been accepted, and this app's
 * ownership afterwards is a separate fact — one that decides whether the
 * composer unblocks. Writing "we own it now" from the success flag alone is
 * exactly the inference that would put a reply box over a thread Graph will
 * refuse.
 */
export async function applyMetaControl(input: {
  conversationId: string;
  platform: MetaPlatform;
  intent: 'take' | 'release';
  actorAgentId: string;
  actorName: string;
  ticketNumber: number;
}): Promise<MetaControlOutcome> {
  const target = await metaReplyTarget(input.conversationId, input.platform);
  const recipientId = target.recipientId;
  if (!recipientId) {
    throw new MetaControlError(
      'This ticket has no inbound message, so there is no thread to take control of.',
    );
  }

  const previousOwnerAppId = target.control.appId;

  // Meta shows `metadata` to the app on the other side of the handover. Naming
  // the ticket and the person makes a transfer traceable from whichever tool
  // lost the thread, which is the tool whose operator is about to wonder why a
  // conversation went quiet.
  const metadata = `ShipBlu Support ticket #${input.ticketNumber} — ${input.actorName}`;

  let result: MetaControlOutcome['result'];

  if (input.intent === 'release') {
    await callGraph(() => releaseThreadControl(input.platform, recipientId, metadata));
    result = 'released';
  } else {
    try {
      await takeThreadControl(input.platform, recipientId, metadata);
      result = 'taken';
    } catch (caught) {
      /*
        Taking is only open to the page's primary receiver, and to any app when
        the thread is idle. Everyone else gets `100 / 2534037` — "the action is
        invalid since it's not the thread owner" — and Meta's documented answer
        for them is to *ask*: `request_thread_control` notifies the current
        owner, which may hand over or ignore it.

        Falling back rather than surfacing the refusal, because the refusal is
        not information the agent can act on — they cannot make this app a
        primary receiver from the composer, and asking is the only remaining
        move. It is reported honestly as a request, never as a transfer.
      */
      if (!isNotThreadOwner(caught)) throw asControlError(caught);

      await callGraph(() => requestThreadControl(input.platform, recipientId, metadata));
      result = 'requested';
    }
  }

  const view = await confirm(input.conversationId, input.platform, input.intent, result);

  await db.insert(conversationEvents).values({
    conversationId: input.conversationId,
    type:
      result === 'taken'
        ? 'meta_control_taken'
        : result === 'released'
          ? 'meta_control_released'
          : 'meta_control_requested',
    actorAgentId: input.actorAgentId,
    data: {
      platform: input.platform,
      intent: input.intent,
      result,
      previousOwnerAppId,
      previousOwner: describeAppId(previousOwnerAppId),
      ownerAppId: view.state.ownerAppId,
      holder: view.state.holder,
      // Recorded when the confirming read failed, so a later reader can tell
      // "control did not move" from "we never found out whether it did".
      confirmed: !view.stale,
    },
  });

  return { result, view };
}

/**
 * Re-reads ownership after a write, and persists what it finds.
 *
 * When the read itself fails there is still something honest to record: a
 * completed take or release moved control in a known direction, and writing
 * that keeps the composer consistent with what the agent was just told. A
 * *request* moved nothing, so it writes nothing.
 */
async function confirm(
  conversationId: string,
  platform: MetaPlatform,
  intent: 'take' | 'release',
  result: MetaControlOutcome['result'],
): Promise<MetaControlView> {
  const view = await readMetaControl(conversationId, platform);
  if (!view.stale || result === 'requested') return view;

  const ourAppId = env().META_APP_ID ?? null;
  const appId = intent === 'take' ? ourAppId : null;
  await storeControl(conversationId, appId, new Date());

  return {
    ...view,
    state: metaControlState({
      platform,
      ourAppId,
      reading: { appId, expiresAt: null },
      standby: false,
    }),
    checkedAt: new Date(),
  };
}

async function storeControl(
  conversationId: string,
  appId: string | null,
  checkedAt: Date,
): Promise<void> {
  await db
    .update(conversations)
    .set({ metaControlAppId: appId, metaControlCheckedAt: checkedAt })
    .where(eq(conversations.id, conversationId));
}

/** A refusal worth putting in front of the agent, rather than a stack trace. */
export class MetaControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaControlError';
  }
}

async function callGraph(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (caught) {
    throw asControlError(caught);
  }
}

function asControlError(caught: unknown): MetaControlError {
  return new MetaControlError(describeGraphFailure(caught));
}

/**
 * `error_user_msg` first: it is the only field Graph writes for a person, and
 * on the handover endpoints it is usually the one that names the actual rule.
 */
function describeGraphFailure(caught: unknown): string {
  if (caught instanceof MetaApiError) {
    const detail = caught.userMessage ?? caught.message;
    return caught.traceId ? `${detail} (Meta trace ${caught.traceId})` : detail;
  }
  return caught instanceof Error ? caught.message : String(caught);
}
