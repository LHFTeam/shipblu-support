/**
 * The sentence a ticket's timeline prints for each `conversation_events` row.
 *
 * Pure wording, so it lives in `lib/` with tests beside it rather than inside
 * the ticket page's client component. It imports nothing, which keeps it safe
 * for the browser bundle that renders the timeline.
 */

const SKIP_REASONS: Record<string, string> = {
  outside_hours: 'the group was outside its business hours',
  no_group_members: 'the group has no members',
  none_available: 'nobody in the group was online and accepting tickets',
  all_at_capacity: 'everybody available was at their ticket limit',
  no_skill_match: 'nobody available held every skill it needs',
};

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
    case 'assigned':
      return 'reassigned the ticket';
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
      return 're-counted the due dates';

    // The six categorisation events, and they need cases here for exactly the
    // reason `unverified_submitter` above does: the default prints the type
    // with its underscores swapped for spaces and drops the payload, so the
    // timeline read "category added" with no category in it. The actions all
    // store what was decided; this is where it becomes readable.
    case 'categorised': {
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
      return `filed this under ${String(data.categoryKey ?? 'a category')}`;
    case 'category_confirmed':
      return `confirmed ${String(data.categoryKey ?? 'a suggested category')}`;
    case 'category_rejected':
      return `rejected ${String(data.categoryKey ?? 'a suggested category')}`;
    case 'category_removed':
      return `removed ${String(data.categoryKey ?? 'a category')}`;
    case 'root_cause_set':
      // Null is the clear, not a missing payload: `setRootCause` writes the key
      // it resolved, and writes null when an agent picks "Not established yet".
      return data.rootCauseKey
        ? `recorded the cause as ${String(data.rootCauseKey)}`
        : 'cleared the recorded cause';

    default:
      return type.replace(/_/g, ' ');
  }
}
