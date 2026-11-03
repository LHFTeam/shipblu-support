# The launch reset: close the pre-launch backlog and start the reports on 2026-11-03

The helpdesk launches on **2026-11-03 (Cairo)**. Until then nobody worked it
for real, so the user asked for two things: every ticket received before the
launch closed, and every counter starting at the launch, because figures drawn
from weeks of unworked traffic describe nothing.

Nothing in this file has been run against production. Every write below waits
for the user's go-ahead for that step and follows the `AGENTS.md` sequence:
read the state, say the change, have the way back.

## What was measured (production, read-only, 2026-11-02 14:00–17:50 UTC)

| Population                               | Count                                                                                                            | Note                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Team tickets open or pending             | 579                                                                                                              | Facebook 297, WhatsApp 124, Instagram 94, comments 57, chat 5, email 1         |
| … of which the customer spoke last       | ~480                                                                                                             | 295 Facebook DMs never answered here; every Instagram reply since 10-29 failed |
| … on Nayera Mohamed's coexistence number | 116                                                                                                              | answered from her phone; 15 had a message in the last 24 hours                 |
| Team tickets resolved, native            | 9                                                                                                                | a customer's next message would reopen them after the launch                   |
| `whatsapp_bot` tickets, all open         | 83,045                                                                                                           | transcripts; in no counter; ~1,200–2,000 new a day                             |
| Rollup rows before the launch            | 373 `metrics_daily`, 684 `agent_metrics_daily`, 471 `subcategory_metrics_daily`, 65 `rollup_days`, 0 root causes | rebuilt from tickets                                                           |
| `csat_surveys`                           | 1                                                                                                                | sent 2026-08-31, never answered                                                |
| `conversations_number_seq`               | 83,7xx                                                                                                           | shared with the bot, unique-indexed                                            |

CSAT is off (`csat_settings.enabled = false`), the one auto-response is
inactive, no `on_update` rule exists, no job is pending, and `routing_decisions`
is empty, so no step below messages a customer.

## Decisions

1. **Closed, never Resolved.** A close leaves `resolved_at` null
   (`resolveStamp('closed')`), so no resolution, resolution time or resolution
   SLA verdict lands on any day. A closed WhatsApp, Meta DM or widget ticket is
   never continued (`live-conversation.ts`), so the customer's next message
   opens a fresh post-launch ticket. A resolved one would be reopened by it, and
   the reopen counted after launch. The 9 native resolved tickets are closed for
   that reason; the 47 imported WhatsApp histories are left as they are.
2. **No actor on the close.** The agent rollup counts every event with an
   `actor_agent_id` as a ticket that agent touched, so the deciding admin is
   named in `data.by`, as the 2026-10-30 group move did.
3. **Not the bot.** Its transcripts are already outside every counter
   (`workedConversation`, `readOnlyChannels`). Closing them would make each
   returning bot user open a new ticket, burn ticket numbers and fire ~166k
   `NOTIFY`s, for no figure.
4. **The reports start on the launch day, in code** (`REPORTS_START_DATE`,
   `AGENTS.md` "The reports can start on a day"). Deleting the old rollup rows
   alone does not hold: the nightly rebuilds the three days before it, and a
   bare `rollup_metrics to=` starts at the oldest ticket. Nor does it stop a
   pre-launch ticket answered after the launch putting a response time counted
   from weeks before onto a launch-week day — on 2026-11-01 two such answers
   made the day's mean first response 675 minutes. The variable floors both.
5. **Left alone:** backlog snapshots and presence and focus intervals (captured
   once, read only for their own day, irrecoverable), the `ai_*` run tables (the
   classifiers' only labels), subcategory labels, the knowledge base's view and
   vote counts (Freshdesk's real history; zeroing them empties "Most read" and
   the widget's FAQ), dead jobs (real failures), and `canned_suggestions`
   (`coverage()` counts replies live, so deleting the rows understates it).
6. **Ticket numbers are not reset.** `conversations.number` is one unique
   sequence shared with the bot. Reset to 1, every insert fails on the unique
   index; deleted and reset, an old signed email reply token (`support+c<N>`)
   lands on another customer's ticket of the same number.

## Open questions for the user

- **Who answers the ~480 customers waiting on Facebook and Instagram?** If
  Freshchat or the phone does (Messenger's thread control is still Freshchat's),
  closing them here buries nothing. If this console was meant to, closing them
  hides them: a closed ticket is in no default view, and nothing notifies anyone
  when a customer writes.
- **The 15 tickets whose last agent reply failed** (Instagram's token, expired
  since 2026-10-29): the agents believe they were answered. Re-send them from
  the native app, or keep them out of the close until the token is renewed.

## Steps

### 1. Before the write

Read each of these, and stop on any surprise:

1. The minute is not a multiple of five. `sla_sweep` runs `*/5` and writes a
   breach without re-checking the status; run at :07–:09, :17–:19 and so on.
2. `csat_settings.enabled = false`; no active `auto_responses` row; the active
   `automation_rules` are the two web chat routes and "Close resolved tickets
   after 3 days", with no `on_update` rule.
3. `jobs` holds no pending or processing `send_*`, `send_csat` or
   `settle_routing` job.
4. `pg_stat_activity` shows no other transaction open longer than 10 seconds.
5. The dry run below, by channel and status. Set the guard's bounds from it.
6. Export, as ticket numbers only, the customers still waiting from the last 7
   days and the 15 failed-reply tickets, for the shift lead.

Dry run:

```sql
with params as (
  select timestamptz '2026-11-02 22:00:00Z' as cutoff,
         'e65286af-c512-4903-9f4a-7a96cb986f04'::uuid as owned_number
)
select s.category, c.channel, count(*) as to_close
from conversations c
join ticket_statuses s on s.id = c.status_id
cross join params k
where s.category in ('open','pending','resolved')
  and c.channel <> 'whatsapp_bot' and c.source_system <> 'import'
  and c.deleted_at is null and c.merged_into_id is null and not c.is_spam
  and c.created_at < k.cutoff
  and coalesce(c.last_customer_message_at, c.created_at) < k.cutoff
  and not (c.routing_window_ends_at is not null and c.routing_decided_at is null)
  and (c.channel_id is distinct from k.owned_number
       or c.last_message_at < now() - interval '24 hours')
  and not coalesce(c.channel in ('webchat','email','whatsapp')
        and c.channel_id is distinct from k.owned_number
        and c.last_customer_message_at >= k.cutoff - interval '24 hours'
        and (c.last_agent_message_at is null
             or c.last_customer_message_at > c.last_agent_message_at), false)
group by rollup (1, 2) order by 1 nulls last, 2 nulls last;
```

What the scope keeps open, and why:

- a ticket the customer wrote to after the cutoff — that is launch-day work;
- a ticket in a routing hold, which `settle_routing` decides first;
- a thread on Nayera's number with a message in the last 24 hours in either
  direction. Closed mid-conversation, the merchant's question stays on the
  closed ticket and her answer opens a new one; and her writing first from the
  phone files a resolved ticket that the merchant's reply reopens, which would
  roughly triple launch week's WhatsApp reopen figure. Step 5 closes the rest;
- a web chat, email or plain-WhatsApp customer still waiting from the 24 hours
  before the cutoff (none on 2026-11-02).

### 2. The close (one statement, one transaction)

Replace `REPLACE_WITH_ADMIN_UUID` with the deciding admin's id, and `LOW`/`HIGH`
with the dry run's total a minute before, ±5. An unreplaced id fails the cast
and writes nothing; a count outside the bounds aborts the whole statement.

```sql
set lock_timeout = '3s';
with params as (
  select timestamptz '2026-11-02 22:00:00Z' as cutoff,     -- 2026-11-03 00:00 Africa/Cairo
         'launch_2026_11_03'::text as reason,
         'e65286af-c512-4903-9f4a-7a96cb986f04'::uuid as owned_number,
         (select a.id from agents a
           where a.id = 'REPLACE_WITH_ADMIN_UUID'::uuid and a.is_active) as by_agent
),
target as (
  select t.id, t.name from ticket_statuses t
  where t.id = 'afcc28fe-a22c-4fd6-a885-4c2fdc5721b6' and t.category = 'closed'
),
picked as (
  select c.id, c.status_id as from_status_id, s.name as from_status
  from conversations c
  join ticket_statuses s on s.id = c.status_id
  cross join params k
  where s.category in ('open','pending','resolved')
    and c.channel <> 'whatsapp_bot' and c.source_system <> 'import'
    and c.deleted_at is null and c.merged_into_id is null and not c.is_spam
    and c.created_at < k.cutoff
    and coalesce(c.last_customer_message_at, c.created_at) < k.cutoff
    and not (c.routing_window_ends_at is not null and c.routing_decided_at is null)
    and (c.channel_id is distinct from k.owned_number
         or c.last_message_at < now() - interval '24 hours')
    and not coalesce(c.channel in ('webchat','email','whatsapp')
          and c.channel_id is distinct from k.owned_number
          and c.last_customer_message_at >= k.cutoff - interval '24 hours'
          and (c.last_agent_message_at is null
               or c.last_customer_message_at > c.last_agent_message_at), false)
    and k.by_agent is not null
  for no key update of c
),
moved as (
  update conversations c
     set status_id = t.id, closed_at = now()
    from picked p, target t
   where c.id = p.id and c.status_id = p.from_status_id
  returning c.id, p.from_status_id, p.from_status, t.name as to_status,
            clock_timestamp() as stamp,
            (select count(*) from messages m
              where m.conversation_id = c.id and m.direction = 'inbound' and m.kind = 'reply'
                and m.meta->>'whatsappType' is distinct from 'reaction') as inbound_at_close
),
closed_events as (
  insert into conversation_events (conversation_id, type, actor_label, created_at, data)
  select m.id, 'status_changed', 'Launch cleanup', m.stamp,
         jsonb_build_object('to', m.to_status, 'category', 'closed',
                            'from', m.from_status, 'fromStatusId', m.from_status_id,
                            'reason', k.reason, 'by', k.by_agent,
                            'inboundAtClose', m.inbound_at_close)
  from moved m cross join params k
  returning conversation_id
),
paused_events as (
  -- changeClock's parity: a pause unless the clock is already paused, stamped
  -- just after the close as the app's would be, and tagged so the way back
  -- can find it.
  insert into conversation_events (conversation_id, type, actor_label, created_at, data)
  select m.id, 'sla_paused', 'sla', p.at,
         jsonb_build_object('at', to_char(p.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                            'reason', k.reason)
  from moved m cross join params k
  cross join lateral (select date_trunc('milliseconds', m.stamp) + interval '1 millisecond' as at) p
  where coalesce((select e.type from conversation_events e
                   where e.conversation_id = m.id and e.type in ('sla_paused','sla_resumed')
                   order by e.created_at desc limit 1), 'sla_resumed') <> 'sla_paused'
  returning conversation_id
)
select (select count(*) from moved) as closed,
       (select count(*) from closed_events) as status_events,
       (select count(*) from paused_events) as pause_events,
       case when (select count(*) from moved) not between LOW and HIGH
            then ('abort: would close ' || (select count(*) from moved))::int end as guard;
```

`lock_timeout` keeps a row held by ingest from making the statement sit on
~590 row locks for two minutes; on a timeout nothing is written and the
statement is simply run again. A second run closes nothing.

Verify, expecting `status_events = tickets = still_closed`, the resolved count
from the dry run, and the last two columns 0:

```sql
with k as (select 'launch_2026_11_03'::text reason,
                  'afcc28fe-a22c-4fd6-a885-4c2fdc5721b6'::uuid closed_id),
ev as (select e.conversation_id, e.data from conversation_events e, k
       where e.type = 'status_changed' and e.data->>'reason' = k.reason)
select (select count(*) from ev) status_events,
       (select count(distinct conversation_id) from ev) tickets,
       (select count(*) from ev join conversations c on c.id = ev.conversation_id, k
          where c.status_id = k.closed_id and c.closed_at is not null) still_closed,
       (select count(*) from ev join conversations c on c.id = ev.conversation_id
          where ev.data->>'from' = 'Resolved' and c.resolved_at is not null) resolved_kept_resolved_at,
       (select count(*) from ev join conversations c on c.id = ev.conversation_id
          where ev.data->>'from' <> 'Resolved' and c.resolved_at is not null) unresolved_with_resolved_at,
       (select count(*) from ev where coalesce((select e.type from conversation_events e
           where e.conversation_id = ev.conversation_id and e.type in ('sla_paused','sla_resumed')
           order by e.created_at desc limit 1), 'none') <> 'sla_paused') clock_not_paused;
```

### 3. Ship the floor, then delete the old days

1. Merge this branch's pull request into `dev`, `dev` into `main`, and deploy
   **all six** production services: `npm run job -- rollup_metrics` can be
   started from any service's shell, and an old one rebuilds the history.
2. Set `REPORTS_START_DATE=2026-11-03` in the `shipblu-support-production` env
   group. A group change redeploys the services that link it.
3. Delete the old days, in one statement so the tables lose their history
   together (expected, as of 2026-11-02: 373, 684, 471, 0, 65 — plus the three
   days the 2026-11-03 nightly rebuilt — and 1):

```sql
with k as (select date '2026-11-03' launch_day, timestamptz '2026-11-02 22:00:00Z' cutoff),
md  as (delete from metrics_daily             t using k where t.day < k.launch_day returning 1),
amd as (delete from agent_metrics_daily       t using k where t.day < k.launch_day returning 1),
smd as (delete from subcategory_metrics_daily t using k where t.day < k.launch_day returning 1),
rmd as (delete from root_cause_metrics_daily  t using k where t.day < k.launch_day returning 1),
rd  as (delete from rollup_days               t using k where t.day < k.launch_day returning 1),
cs  as (delete from csat_surveys              t using k where t.created_at < k.cutoff returning 1)
select (select count(*) from md) metrics_daily, (select count(*) from amd) agent_metrics_daily,
       (select count(*) from smd) subcategory_metrics_daily, (select count(*) from rmd) root_cause_metrics_daily,
       (select count(*) from rd) rollup_days, (select count(*) from cs) csat_surveys;
```

4. The next nightly (00:00 UTC) logs
   `[rollup_metrics] reports start on 2026-11-03: no earlier day is planned` and
   rebuilds 2026-11-03 alone; `select min(day) from metrics_daily` reads
   2026-11-03, and the overview, CSAT and subcategory pages say their history
   begins on it.

Until the nightly on 2026-11-04, `metrics_daily` is empty: the live board's
health tile reads "the nightly job has never run", and the report pages show
their empty state. That is the truth for the first day.

### 4. Every day for two weeks

Anything a customer sent onto a ticket the close closed. Email and Meta comment
threads file a later message onto a closed ticket without reopening it, and a
message in flight during the close can land there too. None has in the
archive's history, and this is how to see the first:

```sql
with closes as (
  select distinct on (e.conversation_id) e.conversation_id, e.created_at closed_at,
         (e.data->>'inboundAtClose')::int inbound_at_close
  from conversation_events e
  where e.type = 'status_changed' and e.data->>'reason' = 'launch_2026_11_03'
  order by e.conversation_id, e.created_at desc
)
select c.number, c.channel, s.category status_now, k.closed_at,
       n.inbound_now - k.inbound_at_close new_customer_messages, n.newest_inbound_at
from closes k
join conversations c on c.id = k.conversation_id
join ticket_statuses s on s.id = c.status_id
cross join lateral (
  select count(*) inbound_now, max(m.created_at) newest_inbound_at from messages m
  where m.conversation_id = k.conversation_id and m.direction = 'inbound' and m.kind = 'reply'
    and m.meta->>'whatsappType' is distinct from 'reaction') n
where n.inbound_now > k.inbound_at_close
order by n.newest_inbound_at desc;
```

### 5. 2026-11-04: Nayera's remaining threads

Re-run step 2 unchanged (same `reason`, same cutoff), after the dry run. Its
idle clause now closes the threads that have been quiet for a day; the ones a
merchant wrote to after the cutoff stay open, as launch work.

## Retired by this

- The `rollup_metrics from=2026-08-18` rebuild waiting on the category
  backlog: with the floor it starts at 2026-11-03.
- `backfill_category_ai mode=apply` files only open or pending tickets, so after
  the close it files nothing. Run it before the close if the archive's
  categories are wanted, or retire it.

## The way back

**The close.** Restore only what nobody has touched since and whose thread has
not moved on to a newer ticket; list the rest by number for a person. Run the
dry run first:

```sql
with k as (select 'launch_2026_11_03'::text reason,
                  'afcc28fe-a22c-4fd6-a885-4c2fdc5721b6'::uuid closed_id),
cleanup as (select e.conversation_id, e.created_at, e.data->>'from' from_status
            from conversation_events e, k
            where e.type = 'status_changed' and e.data->>'reason' = k.reason)
select x.from_status, c.status_id = k.closed_id as still_closed,
       exists (select 1 from conversation_events l where l.conversation_id = x.conversation_id
                 and l.created_at > x.created_at
                 and l.type in ('status_changed','reopened','sla_resumed')) as touched_since,
       exists (select 1 from conversations n where n.requester_contact_id = c.requester_contact_id
                 and n.channel = c.channel and n.channel_id is not distinct from c.channel_id
                 and n.id <> c.id and n.created_at > x.created_at
                 and n.deleted_at is null and n.merged_into_id is null) as newer_ticket_on_thread,
       count(*)
from cleanup x join conversations c on c.id = x.conversation_id cross join k
group by 1, 2, 3, 4 order by 1, 2, 3, 4;
```

```sql
set lock_timeout = '3s';
with k as (select 'launch_2026_11_03'::text reason,
                  'afcc28fe-a22c-4fd6-a885-4c2fdc5721b6'::uuid closed_id),
cleanup as (
  select e.id event_id, e.conversation_id, e.created_at, (e.data->>'fromStatusId')::uuid from_status_id
  from conversation_events e, k
  where e.type = 'status_changed' and e.data->>'reason' = k.reason
),
restorable as (
  select x.event_id, x.conversation_id, x.from_status_id
  from cleanup x join conversations c on c.id = x.conversation_id cross join k
  where c.status_id = k.closed_id
    and c.deleted_at is null and c.merged_into_id is null and not c.is_spam
    and not exists (select 1 from conversation_events l
                     where l.conversation_id = x.conversation_id and l.created_at > x.created_at
                       and l.type in ('status_changed','reopened','sla_resumed'))
    and not exists (select 1 from conversations n
                     where n.requester_contact_id = c.requester_contact_id
                       and n.channel = c.channel and n.channel_id is not distinct from c.channel_id
                       and n.id <> c.id and n.created_at > x.created_at
                       and n.deleted_at is null and n.merged_into_id is null)
  for no key update of c
),
restored as (
  update conversations c set status_id = r.from_status_id, closed_at = null
    from restorable r, k
   where c.id = r.conversation_id and c.status_id = k.closed_id
  returning c.id, r.event_id
),
dropped_status as (delete from conversation_events e using restored r
                    where e.id = r.event_id returning e.id),
dropped_pause as (delete from conversation_events e using restored r, k
                   where e.conversation_id = r.id and e.type = 'sla_paused'
                     and e.data->>'reason' = k.reason
                  returning e.id)
select (select count(*) from cleanup) cleanup_events, (select count(*) from restored) restored,
       (select count(*) from dropped_status) status_events_deleted,
       (select count(*) from dropped_pause) pause_events_deleted;
```

The way back messages nobody: restored resolved tickets re-enter "Close
resolved tickets after 3 days", restored open ones re-enter `sla_sweep`, whose
escalation adds watchers and emails nobody.

**The floor.** Unset `REPORTS_START_DATE`, then
`npm run job -- rollup_metrics from=2026-08-18` rebuilds the deleted days from
the tickets as they then stand. The one CSAT survey row does not come back.

## Separate from the reset, and in the way of the launch

- `INSTAGRAM_ACCESS_TOKEN` expired at 15:25 UTC on 2026-10-29: every Instagram
  reply since has failed (five `send_meta` jobs dead on 2026-11-02, sent by the
  new agents on their first day).
- Messenger replies wait on the Freshworks swap: Freshchat holds thread
  control, and every Page delivery arrives in `standby` (§5.1).
- Meta's Human Agent feature is not approved, so a Facebook or Instagram reply
  sent 24 hours to 7 days after the customer's last message fails.
- Every live policy gives a 1–2 minute first-response target, so launch week's
  breach rate will be the headline figure; the targets are worth a look before
  anybody reads it.
