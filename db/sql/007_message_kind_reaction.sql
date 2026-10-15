-- Post-migration SQL: every stored WhatsApp reaction carries the kind that says
-- so.
--
-- Until migration 0035 a reaction was stored as `kind = 'reply'`, told apart
-- only by `meta->>'whatsappType' = 'reaction'`, so every reader that picks the
-- customer's words had to remember a second filter. Migration 0035 added
-- `reaction` to `message_kind`, and ingest now writes it; this moves the rows
-- stored before it — 1,232 in production on 2026-10-15, 1,162 of them the bot's.
--
-- Here rather than in the migration because Postgres refuses to use an enum
-- value inside the transaction that added it (55P04, "unsafe use of new
-- value"), and drizzle runs every pending migration in one transaction. These
-- files run afterwards, each on its own, once the value has committed.
--
-- **Replayed on every deploy, and that is the point.** Only the web services
-- run `db:migrate`; the worker is deployed after them, and an old worker keeps
-- storing reactions as `reply` until it is. Each later deploy moves whatever it
-- wrote in between, so no row is left behind by the gap between the two. Until the worker runs the new code, the readers still also check the tag
-- (`notReaction`, `isReaction`) for the same reason.
--
-- **The body narrows the scan; the tag decides.** Nothing indexes the tag, and
-- filtering on it alone took 6.5 seconds over production's 219k rows — against
-- 1.3 to scan the table on `kind` — on every deploy, and growing with the
-- table. `body_text LIKE '[reacted%'` is answered by `messages_body_trgm_idx`
-- (001) and reaches the same 1,232 rows in 0.9 seconds. It cannot miss one,
-- because the only rows this file is for were written by code that no longer
-- changes — ingest before this release, which stored every reaction, live or
-- copied, as `displayText` renders one: `[reacted 🙏]`, or `[reacted]` for one
-- taken back. In production on 2026-10-15 no tagged row lacked the prefix and
-- no untagged row had it. The tag is still the condition, so a customer who
-- types "[reacted" is not moved.
--
-- **Idempotent** on the condition that selects the row: once moved, a row is no
-- longer `reply`, so the second run matches nothing. The tag on `meta` stays,
-- deliberately — the code before this change reads it, so rolling back to it
-- still leaves every reaction out of what it filtered. Undoing the data is the
-- same statement the other way round, with this file removed in that change or
-- the next deploy moves the rows again.
--
-- Each row moved fires `notify_change` once, which refreshes a ticket somebody
-- has open and leaves the queue alone (an update to a message is not
-- queue-relevant).
UPDATE messages
   SET kind = 'reaction'
 WHERE kind = 'reply'
   AND body_text LIKE '[reacted%'
   AND meta->>'whatsappType' = 'reaction';
