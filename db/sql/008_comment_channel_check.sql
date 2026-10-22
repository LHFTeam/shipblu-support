-- Post-migration SQL: a ticket's channel and its external id are one answer.
--
-- Every statement here MUST be idempotent. db/migrate.ts re-runs this file after
-- every drizzle migration, and Postgres has no ADD CONSTRAINT IF NOT EXISTS, so
-- the constraint is guarded on pg_constraint, and on the table as well as the
-- name, so a constraint of the same name on another table cannot satisfy it.
--
-- Its own file rather than a block in 003_constraints.sql, for two reasons. If
-- a row refuses it, the migrate log names this file ("Applying 008_…") rather
-- than one block among many; and its rollback is this file's body replaced by
-- a drop guarded the same way, which touches nothing else (Stage 1.3 of
-- plans/ticket-category-routing.md). Guarded, not a bare DROP CONSTRAINT IF
-- EXISTS: ALTER TABLE takes its ACCESS EXCLUSIVE lock before it checks IF
-- EXISTS, so the bare form would lock conversations on every later deploy to do
-- nothing — the failure 001's trigger loop describes, from 2026-08-19.

-- --------------------------------------------------------------------------
-- A comment ticket is on its comment channel, and only a comment ticket is
--
-- A Facebook or Instagram comment ticket is filed under the root of its thread,
-- `<platform>:comment:<root>` in external_id, and since Stage 1.2 on the
-- channel `facebook_comment` / `instagram_comment`. Before that it sat on its
-- platform's channel, told apart only by the external id, so every reader that
-- replies on its own had to ask both (`isCommentTicket`), and a reader that
-- asked only the channel would have answered a public comment as a private
-- message. split_comment_channels moved every such ticket; this keeps one from
-- ever being written again, by any path.
--
-- Stricter than "the channel is a comment channel exactly when the id names a
-- comment", in two ways nothing writes today:
--   - the platform is pinned, so an Instagram comment's id cannot sit on
--     `facebook_comment` and send its reply to the wrong Graph host;
--   - a comment channel needs a root (one character after the prefix), as
--     `rootCommentId` does, so an id it would read as no comment at all is
--     refused rather than filed as a comment with nothing to reply to.
-- Off the comment channels, anything shaped like a comment id is refused,
-- root or no root.
--
-- Never null, so never passed by default: `channel` is NOT NULL and every arm
-- coalesces the external id. Added VALID, not NOT VALID: the point is that
-- every row is checked, once. That takes an ACCESS EXCLUSIVE lock on
-- conversations for as long as the scan does, and db/migrate.ts gives up after
-- its 10 s lock_timeout, so the deploy that adds it is triggered with nothing
-- else open on the table.
-- --------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_comment_channel_matches_external_id'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_comment_channel_matches_external_id
      CHECK (CASE channel
        WHEN 'facebook_comment' THEN coalesce(external_id, '') ~ '^facebook:comment:.'
        WHEN 'instagram_comment' THEN coalesce(external_id, '') ~ '^instagram:comment:.'
        ELSE coalesce(external_id, '') !~ '^(facebook|instagram):comment:'
      END);
  END IF;
END $$;
