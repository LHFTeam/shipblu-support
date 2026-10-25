import { describeAnswerSource, describeDelivery } from '@/lib/csat/delivery';
import { describeSkip } from '@/lib/csat/skip-reasons';

/**
 * The sentence a ticket's timeline prints for each `conversation_events` row.
 *
 * Pure wording, so it lives in `lib/` with tests beside it rather than inside
 * the ticket page's client component. It imports nothing but the survey's
 * skip-reason list, itself pure, which keeps it safe for the browser bundle
 * that renders the timeline.
 */

const SKIP_REASONS: Record<string, string> = {
  outside_hours: 'the group was outside its business hours',
  no_group_members: 'the group has no members',
  none_available: 'nobody in the group was online and accepting tickets',
  all_at_capacity: 'everybody available was at their ticket limit',
  no_skill_match: 'nobody available held every skill it needs',
};

/**
 * The subcategory an event is about. Written as `categoryKey` until Stage 2.A
 * of `plans/ticket-category-routing.md` and as `subcategoryKey` since, and
 * stored rows are never rewritten, so both are read.
 */
function subcategoryKeyOf(data: Record<string, unknown>): unknown {
  return data.subcategoryKey ?? data.categoryKey;
}

/**
 * The name a timeline prints for an event no agent wrote. The rules detector
 * signed its events `category-detector` until Stage 2.A and
 * `subcategory-detector` since, and one ticket's history can hold both; read
 * as two names, they would look like two mechanisms.
 */
export function describeActorLabel(label: string | null): string | null {
  return label === 'category-detector' ? 'subcategory-detector' : label;
}

export function describeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    // The whole point of the event. Without a case here it fell through to the
    // default and read "unverified submitter" — no address, no client address —
    // so the one record of who *claimed* to have filed the ticket was written
    // and then never shown to anybody.
    case 'unverified_submitter':
      return `submitted without signing in, as ${String(data.email ?? 'an unknown address')}${
        data.ip ? ` from ${String(data.ip)}` : ''
      }`;
    case 'opened_by_agent':
      return 'opened this ticket on the customer’s behalf';
    case 'status_changed':
      return `set status to ${String(data.to ?? '')}`;
    case 'priority_changed':
      // The classifier records how sure it was, because "Jev set this to urgent"
      // reads very differently at 95% than at 61%, and the agent deciding whether
      // to overrule it should not have to open a table to find out which.
      return typeof data.probability === 'number'
        ? `set priority to ${String(data.to ?? '')} (${Math.round(data.probability * 100)}% likely)`
        : `set priority to ${String(data.to ?? '')}`;
    // Named by the label stored with the change, so a category renamed since
    // still reads as what was chosen. Jev's answers (Stage 4) carry how sure it
    // was, for the reason the priority case above gives.
    case 'category_changed': {
      if (!data.to) return 'cleared the category';
      const named = `set the category to ${String(data.label ?? data.key ?? 'a category')}`;
      return typeof data.probability === 'number'
        ? `${named} (${Math.round(data.probability * 100)}% likely)`
        : named;
    }
    /*
     * The two ways a ticket becomes a WhatsApp number's owner's say so, because
     * otherwise "why is this hers?" has no answer on the page: nobody clicked
     * anything, and the actor printed ahead of the sentence is a mechanism.
     */
    case 'assigned':
      if (data.reason === 'number_owner') {
        return 'gave the ticket to the owner of the WhatsApp number it arrived on';
      }
      if (data.reason === 'number_handover') {
        return 'gave the ticket to the new owner of its WhatsApp number';
      }
      return 'reassigned the ticket';
    /*
     * Who answers for the ticket's SLA, which is not who holds it: a number's
     * owner stays accountable through every reassignment, so this changes only
     * when the number itself changes hands. Said in full, because the sidebar
     * shows the result and not the reason.
     */
    case 'accountable_changed':
      // Worded by what is true at the time, not by why it came about: a
      // handover while the ticket sat resolved is the usual cause, but an
      // owner deactivated and reactivated in between arrives here too.
      if (data.reason === 'reopened_after_handover' || data.reason === 'reopened_by_status') {
        const when =
          data.reason === 'reopened_by_status'
            ? 'when it was reopened'
            : 'when the customer wrote again';
        return data.to
          ? `made the owner of its WhatsApp number accountable for the ticket ${when}: it did not name the number's current owner`
          : `cleared who is accountable for the ticket ${when}: its WhatsApp number has no active owner now, so breaches count against whoever holds it`;
      }
      return data.to
        ? 'made the new owner of its WhatsApp number accountable for the ticket: breaches on it count against them'
        : 'cleared who is accountable for the ticket: its WhatsApp number has no owner now, so breaches count against whoever holds it';
    /*
     * Only ingest writes it today: a comment thread's first comment arriving
     * after a reply under it had opened the ticket. Said, because the header
     * now names somebody other than the person it named a minute ago, and the
     * replier's earlier comments stop counting as the customer's.
     */
    case 'requester_changed':
      return data.reason === 'thread_root'
        ? 'made the author of the thread’s first comment the requester: a reply under it had arrived first and opened the ticket'
        : 'changed the requester';
    case 'unassigned':
      return 'unassigned the ticket';
    case 'group_changed':
      return 'moved the ticket to another group';
    /*
     * The whole point of recording a refusal. A queue that assigns itself has to
     * be able to say why it did not, in a sentence an agent looking at the ticket
     * can act on — "everybody is at their limit" is a different problem from
     * "nobody has the skill", and both are different from "we were shut".
     */
    case 'assignment_skipped':
      return `could not assign it: ${SKIP_REASONS[String(data.reason)] ?? String(data.reason)}`;
    case 'assignment_reclaimed':
      return 'took the ticket back — the agent it was with went offline before replying';
    case 'assignment_escalated':
      return 'escalated it: nobody had picked it up';
    case 'reopened':
      return 'reopened the ticket';
    case 'sla_paused':
      return 'paused the SLA clock';
    case 'sla_resumed':
      return `resumed the SLA clock after ${String(data.pausedMinutes ?? 0)} minutes`;
    case 'shipments_detected': {
      const tracking = Array.isArray(data.trackingNumbers) ? data.trackingNumbers : [];
      const sbids = Array.isArray(data.sbids) ? data.sbids : [];
      const parts = [
        tracking.length ? `shipment${tracking.length > 1 ? 's' : ''} ${tracking.join(', ')}` : null,
        sbids.length ? `account${sbids.length > 1 ? 's' : ''} ${sbids.join(', ')}` : null,
      ].filter(Boolean);
      return `linked ${parts.join(' and ')} from a message`;
    }
    case 'shipment_linked':
      return `linked shipment ${String(data.trackingNumber ?? '')}`;
    case 'shipment_unlinked':
      return `unlinked shipment ${String(data.trackingNumber ?? '')}`;
    case 'shipping_account_linked':
      return `linked account ${String(data.sbid ?? '')}`;
    case 'shipping_account_unlinked':
      return `unlinked account ${String(data.sbid ?? '')}`;
    case 'side_conversation_started':
      return `started a side conversation with ${String(data.to ?? 'an internal team')}`;
    case 'side_conversation_replied':
      // The actor here is the person at the hub, so the name is already printed
      // ahead of this sentence by the caller.
      return `replied on side conversation #${String(data.sideConversationNumber ?? '')}`;
    case 'custom_field_changed': {
      // The value, not just the field name. "set Root cause to damaged in
      // transit" is the whole record; "changed Root cause" sends whoever is
      // reading back through the ticket to work out what it was changed to.
      const label = String(data.label ?? data.key ?? 'a field');
      const to = data.to;
      if (to === null || to === undefined || to === '') return `cleared ${label}`;
      return `set ${label} to ${Array.isArray(to) ? to.join(', ') : String(to)}`;
    }
    case 'profile_refreshed': {
      const name = data.name;
      return name
        ? `looked the customer up at Meta: ${String(name)}`
        : 'looked the customer up at Meta, which had no name for them';
    }
    /*
     * Worth a line of its own rather than being inferred from the reply that
     * follows it. Thread control moves silently and in both directions, so
     * "why could nobody answer this for two days, and what changed?" is a
     * question the timeline can only answer if the moment it changed is on it.
     */
    case 'thread_control_taken':
      return 'took thread control from the app that owned this conversation';
    case 'profile_refresh_refused':
      return data.permission === true
        ? 'asked Meta for the customer\u2019s profile and was refused — the app may not hold Business Asset User Profile Access'
        : 'asked Meta for the customer\u2019s profile and was refused';
    /*
     * Whether the agent may act on the name matters more than the name. An
     * unsigned identity is whatever the browser sent — see
     * `lib/widget/identity.ts` — and "the dashboard says so" is exactly the
     * sentence somebody needs before they read an address change back to a
     * caller.
     */
    case 'contact_identified': {
      const named = String(data.name ?? '').trim();
      const account = [data.accountName, data.accountId]
        .filter(Boolean)
        .map(String)
        .join(' \u00b7 ');
      const parts = [named, account ? `account ${account}` : null].filter(Boolean);
      const who = parts.length > 0 ? parts.join(', ') : 'somebody it did not name';
      return data.verified === true
        ? `identified the visitor as ${who}`
        : `identified the visitor as ${who} \u2014 the dashboard's word, not verified`;
    }
    /*
     * The customer touching the thread without writing in it, and the reason
     * these are on the timeline at all: without them a window that reopened —
     * or a customer who answered with a thumbs-up and then said nothing — is an
     * unexplained gap. The default below would print "meta postback" and drop
     * the payload, which is the button's name and the whole content of the
     * event.
     */
    // `||` and not `??`: `data` is jsonb read back untyped, and an empty string
    // is exactly what the fallback is for — `??` would let one through and end
    // the sentence mid-word. `parse.ts` builds these summaries with `||` chains
    // for the same reason.
    case 'meta_postback':
      return `tapped ${String(data.summary || 'a button')}`;
    case 'meta_referral':
      return `arrived from ${String(data.summary || 'a link')}`;
    case 'meta_reaction':
      // Said in a way that does not read as a question waiting for an answer,
      // because it is not one: a reaction deliberately moves neither the
      // messaging window nor the next-response clock.
      return `reacted with ${String(data.summary || 'a reaction')}`;
    case 'comment_hidden':
      return 'hid the comment on the post';
    case 'comment_unhidden':
      return 'made the comment public again';
    case 'comment_deleted':
      return 'deleted the comment from the post';
    case 'sla_recalculated':
      if (data.reason === 'group_hours') {
        return "re-counted the due dates on the new group's business hours";
      }
      if (data.reason === 'priority') {
        return `re-counted the due dates for ${String(data.priority ?? 'the new')} priority`;
      }
      // `reselectPolicyBeforeFirstResponse`: the ticket is held to a different
      // policy now, and the agent is owed which one and what moved it there.
      if (data.reason === 'policy') {
        const cause = data.cause === 'group' ? 'its group' : 'its category';
        return `held the ticket to the ${String(data.policy ?? 'new')} SLA policy, which matches ${cause} now`;
      }
      return 're-counted the due dates';

    // The six subcategorisation events, and they need cases here for exactly
    // the reason `unverified_submitter` above does: the default prints the type
    // with its underscores swapped for spaces and drops the payload, so the
    // timeline read "category added" with no subcategory in it. The actions all
    // store what was decided; this is where it becomes readable.
    //
    // The first five are read under two names, for good. They were written as
    // `categorised` and `category_*`, with the key in `data.categoryKey`, until
    // Stage 2.A of `plans/ticket-category-routing.md`; stored history keeps its
    // words, and during a deploy both writers run side by side. Stage 3's own
    // category events must take other names, or a ticket's old subcategory
    // history would read as the new field's.
    case 'categorised':
    case 'subcategorised': {
      const applied = Array.isArray(data.applied) ? (data.applied as string[]) : [];
      const suggested = Array.isArray(data.suggested) ? (data.suggested as string[]) : [];
      const parts = [
        applied.length > 0 ? `filed it under ${applied.join(', ')}` : null,
        suggested.length > 0 ? `suggested ${suggested.join(', ')}` : null,
      ].filter(Boolean);
      // Both empty should be unreachable — the event is only written when
      // something was created — but a timeline entry is the wrong place to
      // throw, and saying so is better than an empty sentence.
      return parts.length > 0 ? parts.join(' and ') : 'read the message and found nothing to file';
    }
    case 'category_added':
    case 'subcategory_added':
      return `filed this under ${String(subcategoryKeyOf(data) ?? 'a subcategory')}`;
    case 'category_confirmed':
    case 'subcategory_confirmed':
      return `confirmed ${String(subcategoryKeyOf(data) ?? 'a suggested subcategory')}`;
    case 'category_rejected':
    case 'subcategory_rejected':
      return `rejected ${String(subcategoryKeyOf(data) ?? 'a suggested subcategory')}`;
    case 'category_removed':
    case 'subcategory_removed':
      return `removed ${String(subcategoryKeyOf(data) ?? 'a subcategory')}`;
    case 'root_cause_set':
      // Null is the clear, not a missing payload: `setRootCause` writes the key
      // it resolved, and writes null when an agent picks "Not established yet".
      return data.rootCauseKey
        ? `recorded the cause as ${String(data.rootCauseKey)}`
        : 'cleared the recorded cause';

    // The survey's decisions. Without cases these read "csat skipped" and
    // "csat received" — the type with its underscores swapped — and drop the
    // reason and the score, which are the whole content of the event.
    case 'csat_sent':
      return `sent a satisfaction survey ${describeDelivery(data.delivery)}`;
    case 'csat_skipped':
      return `did not send a satisfaction survey: ${describeSkip(data.reason)}`;
    case 'csat_received': {
      // Where it came from, when the event says: an answer recorded before
      // the second door existed carries no source, and came through the page.
      const from = describeAnswerSource(data.source);
      const score = typeof data.rating === 'number' ? ` ${data.rating} / 5` : '';
      return `rated the support${score}${from ? ` ${from}` : ''}`;
    }
    case 'csat_thanked':
      return 'thanked the customer for their rating';
    case 'csat_fell_back':
      // Written before the buttons are sent, so it says what was decided; the
      // message's own delivery badge says whether they went.
      return 'switched the satisfaction survey to rating buttons: Messenger refused its feedback card';
    case 'csat_suppressed':
      return 'asked that this ticket not be surveyed';
    case 'csat_unsuppressed':
      return 'allowed a satisfaction survey on this ticket again';
    case 'csat_low_rating': {
      // Written as the emails are queued, in one transaction, so it says who
      // was to be told rather than that they were: a send that then fails is
      // the queue's to retry, and one that dies is a dead job, not a delivery.
      const score =
        typeof data.rating === 'number' ? `the ${data.rating} / 5 rating` : 'the rating';
      const told = Array.isArray(data.agentIds) ? data.agentIds.length : 0;
      if (told === 0) {
        return `had nobody to email about ${score}: nobody who can sign in sees both the satisfaction report and every ticket`;
      }
      return `queued an email to ${told} ${told === 1 ? 'supervisor' : 'supervisors'} about ${score}`;
    }

    default:
      return type.replace(/_/g, ' ');
  }
}
