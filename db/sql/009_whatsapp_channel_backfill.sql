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
-- Driven from the null tickets, so a replay reads only those still without a
-- row, not every message. Idempotent: a ticket this has moved no longer
-- matches, and one whose number has no row stays null until one is added.
update conversations c
set channel_id = src.channel_id
from (
  select distinct on (m.conversation_id) m.conversation_id, ch.id as channel_id
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
  and c.channel_id is null;
