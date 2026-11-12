-- Post-migration SQL: the number a WhatsApp ticket filed under no row is on.
--
-- A WhatsApp conversation is threaded on the customer and the `channels` row of
-- the number they wrote to (`ThreadKey` in lib/tickets/live-conversation.ts),
-- and a null `channel_id` matches only another null — never any number, or a
-- ticket with no row would absorb that customer's messages to every number.
-- Tickets ingested before their number had a row carry a null, so without this
-- the customer's next message to that number opens a second ticket beside the
-- live one (production: four, two of them open, all on the support number).
--
-- Each is given the row whose `phoneNumberId` is the number of its newest
-- inbound message that names one of our support numbers. Inbound, because that
-- is the number the customer wrote to; not a reaction, which is filed on a
-- ticket rather than threading it; and a `whatsapp` row only, so a ticket that
-- also holds messages to the bot's number is given the support number among
-- them, never the bot's. An active row only, because that is all
-- `resolveWhatsAppChannel` matches: filed under an inactive row, the ticket
-- would be one the customer's next message — still threaded under no row —
-- can never reach, and every deploy would strand another. Where two active rows
-- name one number, the oldest wins, the order the resolver reads them in.
--
-- A ticket filed under a coexistence row is its number's owner's alone
-- (lib/tickets/owner-only.ts), so one held by anybody but that owner, while
-- they are active, is given to nobody as it is filed, with a line on its
-- timeline saying why — what `fileUnderNumber` (lib/tickets/assignee.ts) does
-- for a ticket the customer writes to again. That function also lets an agent
-- who sees every ticket keep one; this cannot, since who sees every ticket is
-- `can()` over a role and an agent's own overrides, which SQL would have to
-- copy. Nobody is always somebody a ticket may be left with. Nothing assigns
-- it here: the sweep hands it to the number's owner where its group routes,
-- and elsewhere it waits for its customer's next message, the phone's reply or
-- an edit, each of which asks the number's owner first. The one write of
-- `assignee_agent_id` outside that module, named in
-- scripts/ci/rules/assignee-confinement.mjs.
--
-- Two statements, for the order locks are taken in. A handover locks the
-- number's row and then collects its tickets (`handOverNumber`), and a ticket
-- still under no row is not among them. So the first statement takes, on each
-- coexistence number, the lock a handover waits for, before any ticket's row
-- is written — the channel, then the ticket, as everywhere — and the second
-- reads the owner in a snapshot of its own, taken once that lock is held. Read
-- in one statement, a handover committing while it ran left the ticket filed
-- under the number and held by the owner it had just left. Only a number with
-- a ticket to file — one under no row whose customer wrote to that number,
-- which is the update's own join — so a replay with nothing to do locks
-- nothing. Asked of any ticket under no row instead, it locked every
-- coexistence number on every deploy, since a ticket whose number has no row
-- stays under none, and waited behind any handover in flight.
--
-- A ticket whose holder changed while the update waited for its row is left
-- for the next replay (`held_by`): the line written is about the holder the
-- statement read, and must be about the one it took the ticket from.
--
-- Driven from the null tickets, so a replay reads only those still without a
-- row, not every message. Idempotent: a ticket this has moved no longer
-- matches, and one whose number has no row stays null until one is added.
select ch.id
from channels ch
where ch.type = 'whatsapp'
  and ch.is_active
  and jsonb_typeof(ch.config -> 'coexistence') is not distinct from 'object'
  and exists (
    select 1
    from conversations c
    join messages m on m.conversation_id = c.id
    where c.channel = 'whatsapp'
      and c.channel_id is null
      and m.direction = 'inbound'
      and m.meta->>'whatsappType' is distinct from 'reaction'
      and m.meta->>'phoneNumberId' = ch.config->>'phoneNumberId'
  )
for key share of ch;

with filed as (
  update conversations c
  set channel_id = src.channel_id,
      assignee_agent_id = case when src.strands then null else c.assignee_agent_id end,
      assigned_at = case when src.strands then null else c.assigned_at end
  from (
    select
      placed.*,
      placed.owner_only and placed.held_by is distinct from placed.active_owner_id as strands
    from (
      select distinct on (m.conversation_id)
        m.conversation_id,
        ch.id as channel_id,
        jsonb_typeof(ch.config -> 'coexistence') is not distinct from 'object' as owner_only,
        (select a.id from agents a where a.id = ch.owner_agent_id and a.is_active) as active_owner_id,
        c2.assignee_agent_id as held_by
      from conversations c2
      join messages m on m.conversation_id = c2.id
      join channels ch on ch.type = 'whatsapp'
        and ch.is_active
        and ch.config->>'phoneNumberId' = m.meta->>'phoneNumberId'
      where c2.channel = 'whatsapp'
        and c2.channel_id is null
        and m.direction = 'inbound'
        and m.meta->>'whatsappType' is distinct from 'reaction'
      order by m.conversation_id, m.created_at desc, ch.created_at, ch.id
    ) placed
  ) src
  where c.id = src.conversation_id
    and c.channel_id is null
    and c.assignee_agent_id is not distinct from src.held_by
  returning c.id, src.channel_id, src.strands, src.held_by
)
insert into conversation_events (conversation_id, type, actor_label, data)
select
  id,
  'unassigned',
  'channel_backfill',
  jsonb_build_object(
    'to', null,
    'from', held_by,
    'reason', 'filed_under_number_at_deploy',
    'channelId', channel_id
  )
from filed
where strands
  and held_by is not null;
