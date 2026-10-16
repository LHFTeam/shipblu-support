-- Post-migration SQL: the survey status of rows written before there was one.
--
-- Migration 0035 added `csat_surveys.status` as `csat_status NOT NULL DEFAULT
-- 'sent'`, the only shape an ADD COLUMN on a live table can take — so every
-- survey that existed before it reads as sent and unanswered, including one
-- the customer had answered. Read that way, the sidebar says "no answer yet"
-- beside a rating, the purge panel (which counts `status = 'answered'`) leaves
-- the response out, and the next survey on the ticket marks the answered row
-- `expired` as though it were an unanswered one.
--
-- `responded_at` is what an answer always set, so it is the whole test.
-- Idempotent: a row this has moved no longer matches.
update csat_surveys
set status = 'answered'
where status = 'sent'
  and responded_at is not null;
