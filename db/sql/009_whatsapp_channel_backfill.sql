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
-- copy. Nobody is always somebody a ticket may be left with, and whatever
-- next assigns it asks the number's owner first. The one write of `assignee_agent_id` outside
-- that module, named in scripts/ci/rules/assignee-confinement.mjs. The `case`
-- reads the ticket's own row, so a holder changed while this statement waited
-- for the row is judged as it now is.
--
-- Driven from the null tickets, so a replay reads only those still without a
-- row, not every message. Idempotent: a ticket this has moved no longer
-- matches, and one whose number has no row stays null until one is added.
with filed as (
  update conversations c
  set channel_id = src.channel_id,
      assignee_agent_id = case
        when src.owner_only and c.assignee_agent_id is distinct from src.active_owner_id then null
        else c.assignee_agent_id
      end,
      assigned_at = case
        when src.owner_only and c.assignee_agent_id is distinct from src.active_owner_id then null
        else c.assigned_at
      end
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
  ) src
  where c.id = src.conversation_id
    and c.channel_id is null
  returning c.id, c.channel_id, c.assignee_agent_id, src.owner_only, src.held_by
)
insert into conversation_events (conversation_id, type, actor_label, data)
select
  id,
  'unassigned',
  'channel_backfill',
  jsonb_build_object(
    'to', null,
    'from', held_by,
    'reason', 'filed_under_number',
    'channelId', channel_id
  )
from filed
where owner_only
  and held_by is not null
  and assignee_agent_id is null;
