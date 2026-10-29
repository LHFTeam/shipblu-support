-- Post-migration SQL: constraints Drizzle's schema DSL cannot express.
--
-- Every statement here MUST be idempotent. db/migrate.ts re-runs this file after
-- every drizzle migration, and Postgres has no ADD CONSTRAINT IF NOT EXISTS, so
-- each one is guarded on pg_constraint.

-- --------------------------------------------------------------------------
-- invites.name is required, and NOT NULL is only half of that
--
-- The column being NOT NULL is what the schema can say; it does not exclude the
-- empty string, and '' is exactly what a scripted POST or a future second write
-- path would produce. Everything downstream reasons from "there is a name":
-- the invitation greets the invitee by it, the activation page presents it as
-- already answered, and acceptInvite copies it onto the agent record. With ''
-- all three degrade quietly — "Hi ," in somebody's inbox, an empty required
-- field on the page that promised there was nothing to fill in.
--
-- So the guarantee lives here rather than in the one server action that
-- currently happens to check it.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invites_name_not_blank'
  ) THEN
    ALTER TABLE invites
      ADD CONSTRAINT invites_name_not_blank CHECK (btrim(name) <> '');
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- presence_policy holds exactly one row
--
-- The table is a singleton: one company-wide answer to "when is somebody idle".
-- Nothing in the schema says so, and a second row would not fail anything — it
-- would be picked up or not depending on which one the read happened to order
-- first, so half the fleet would enforce one timeout and half the other, with
-- no error anywhere to explain it.
--
-- Pinning the primary key to 1 makes the upsert in the settings action the only
-- shape that can work, and makes a stray INSERT fail loudly at the moment it is
-- written rather than quietly at the moment it is read.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'presence_policy_singleton'
  ) THEN
    ALTER TABLE presence_policy
      ADD CONSTRAINT presence_policy_singleton CHECK (id = 1);
  END IF;
END $$;

-- The windows are minutes, and a non-positive one is not a shorter timeout — it
-- is a timeout that has already expired for everybody, which on the sign-out
-- side signs the whole team out on the next sweep. The action validates the
-- range too; this is the half that also holds for a hand-written UPDATE against
-- the database, which is how a number nobody would type through the form gets
-- in.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'presence_policy_windows_positive'
  ) THEN
    ALTER TABLE presence_policy
      ADD CONSTRAINT presence_policy_windows_positive CHECK (
        (auto_away_after_mins IS NULL OR auto_away_after_mins > 0)
        AND (auto_signout_after_mins IS NULL OR auto_signout_after_mins > 0)
      );
  END IF;
END $$;

-- Signing out before marking away makes the away state unreachable: the session
-- is destroyed, the stream closes, and the agent goes offline without ever
-- having been away. The ordering is a property of the pair, so it belongs with
-- the pair rather than only in the form that happens to write them today.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'presence_policy_signout_after_away'
  ) THEN
    ALTER TABLE presence_policy
      ADD CONSTRAINT presence_policy_signout_after_away CHECK (
        auto_away_after_mins IS NULL
        OR auto_signout_after_mins IS NULL
        OR auto_signout_after_mins >= auto_away_after_mins
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- An availability reason belongs with the switch being off, and only then
--
-- `shouldRestoreOnInput` reads the pair: not accepting *and* reason `idle` is
-- the one state a keypress may undo. The schema comment asserts the reason is
-- null while accepting, and nothing enforced it — so a hand-written
-- `UPDATE agents SET is_accepting_tickets = true` left `supervisor` behind, and
-- the Team availability page rendered "online · set by a supervisor". That is
-- the case this file exists for: the half of an invariant that also holds for
-- an UPDATE nobody wrote a code path for.
--
-- The backfill has to come first, and it is not a formality: every agent who
-- was switched off before the reason column existed has a null in it, so
-- adding the constraint to a live database without this fails on them. `self`
-- is the honest value — their own switch was the only way it could have been
-- set. Both statements are idempotent, so the replay is a no-op.
-- --------------------------------------------------------------------------
UPDATE agents
   SET accepting_off_reason = 'self'
 WHERE NOT is_accepting_tickets
   AND accepting_off_reason IS NULL;

UPDATE agents
   SET accepting_off_reason = NULL
 WHERE is_accepting_tickets
   AND accepting_off_reason IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_accepting_reason_paired'
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_accepting_reason_paired CHECK (
        (is_accepting_tickets AND accepting_off_reason IS NULL)
        OR (NOT is_accepting_tickets AND accepting_off_reason IS NOT NULL)
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- canned_suggestion_settings holds exactly one row
--
-- The switch that decides whether the reply composer asks TypeSafe for a
-- canned response. The presence_policy reasoning, word for word: a second row
-- would be read or not depending on which one a query happened to order first,
-- so half the fleet would be suggesting and half not, with no error anywhere.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'canned_suggestion_settings_singleton'
  ) THEN
    ALTER TABLE canned_suggestion_settings
      ADD CONSTRAINT canned_suggestion_settings_singleton CHECK (id = 1);
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- A canned suggestion is an answer or a failure, never both
--
-- The report's error rate and its none rate are drawn from disjoint rows; a
-- row carrying a choice and an error would be counted in both, and which one
-- it "really" was is not a question anything could answer afterwards.
--
-- And it is taken or waved away, never both. The composer cannot send both
-- events for one suggestion — accepting hides the dismiss button and the key
-- that sends it — but the event route is an endpoint, and this is the half
-- that also holds for a request the composer did not make.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'canned_suggestions_answer_or_error'
  ) THEN
    ALTER TABLE canned_suggestions
      ADD CONSTRAINT canned_suggestions_answer_or_error CHECK (error IS NULL OR choice IS NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'canned_suggestions_accept_or_dismiss'
  ) THEN
    ALTER TABLE canned_suggestions
      ADD CONSTRAINT canned_suggestions_accept_or_dismiss CHECK (
        accepted_at IS NULL OR dismissed_at IS NULL
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Only a WhatsApp number can belong to a person
--
-- `channels.owner_agent_id` names the team member a business number was handed
-- to, and every ticket arriving on it is stamped as theirs to answer for. That
-- is a fact about a number one person answers from. The bot's number is a
-- self-service funnel nobody replies on, and a mailbox or a Page is read by the
-- whole team; nothing reads an owner off any of them, so one there would be a
-- setting the console shows and nothing honours — until the day a reader is
-- added, when a team inbox's breaches would start landing on one person.
--
-- `handOverNumber` refuses any other type before it writes. This is the half
-- that also holds for an UPDATE nobody wrote a code path for.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_owner_only_whatsapp'
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_owner_only_whatsapp CHECK (
        owner_agent_id IS NULL OR type = 'whatsapp'
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- A ticket category's key, and its two labels
--
-- The key is what every category_changed event freezes, what
-- seed_ticket_categories finds a row by and what Jev's answer names a
-- category by (rules and SLA policies hold the uuid), so it is held to
-- one shape: lowercase words joined by single underscores. Hyphens
-- and capitals belong in the labels. `unknown` is refused because Jev's
-- classifier (plans/ticket-category-routing.md, decision 4) answers it for "none
-- of these", and a category of that name would turn the escape hatch into a
-- label a ticket can be filed under.
--
-- Named `_key_format`, not `_key_shape`: `ticket_categories_key_shape` is the
-- name the subcategory registry's CHECK carried until Stage 2.B renamed that
-- table, and a log line quoting one should never be mistaken for the other.
--
-- Each guard names the table as well as the constraint, as 002's do.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_categories_key_format'
      AND conrelid = 'public.ticket_categories'::regclass
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_key_format CHECK (
        key ~ '^[a-z]+(_[a-z]+)*$' AND key <> 'unknown'
      );
  END IF;

  -- Both labels, because the picker and the badge draw whichever language the
  -- agent reads in, and NOT NULL alone lets '' through — a blank badge on every
  -- ticket filed under it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_categories_labels_not_blank'
      AND conrelid = 'public.ticket_categories'::regclass
  ) THEN
    ALTER TABLE ticket_categories
      ADD CONSTRAINT ticket_categories_labels_not_blank CHECK (
        btrim(label_en) <> '' AND btrim(label_ar) <> ''
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- category_ai_settings holds exactly one row, with values the classifier can read
--
-- The category classifier's switch, threshold and routing window, set on
-- /admin/categories. One row for the canned_suggestion_settings reason: a
-- second would be read or not depending on which one a query ordered first.
-- The ranges are the admin action's too, held here so a row edited straight in
-- the database cannot hand the classifier a threshold above 1 — which applies
-- nothing, silently — or a mode it does not know, which it reads as off.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'category_ai_settings_singleton'
      AND conrelid = 'public.category_ai_settings'::regclass
  ) THEN
    ALTER TABLE category_ai_settings
      ADD CONSTRAINT category_ai_settings_singleton CHECK (id = 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'category_ai_settings_mode_known'
      AND conrelid = 'public.category_ai_settings'::regclass
  ) THEN
    ALTER TABLE category_ai_settings
      ADD CONSTRAINT category_ai_settings_mode_known CHECK (mode IN ('off', 'shadow', 'apply'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'category_ai_settings_min_probability_range'
      AND conrelid = 'public.category_ai_settings'::regclass
  ) THEN
    ALTER TABLE category_ai_settings
      ADD CONSTRAINT category_ai_settings_min_probability_range CHECK (
        min_probability >= 0 AND min_probability <= 1
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'category_ai_settings_window_range'
      AND conrelid = 'public.category_ai_settings'::regclass
  ) THEN
    ALTER TABLE category_ai_settings
      ADD CONSTRAINT category_ai_settings_window_range CHECK (
        routing_window_minutes BETWEEN 1 AND 30
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- A category run that failed says why, and one that did not carries no error
--
-- The live job and the backfill both replace a failed row with the first real
-- answer for its message and label (the upsert over 'failed'). A row that
-- failed without an error, or answered with one, would make "replace the
-- failure" and "replace the error" two different sets of rows.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_category_runs_failed_has_error'
      AND conrelid = 'public.ai_category_runs'::regclass
  ) THEN
    ALTER TABLE ai_category_runs
      ADD CONSTRAINT ai_category_runs_failed_has_error CHECK (
        (outcome = 'failed') = (error IS NOT NULL)
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- A decided routing row says what was decided, and when
--
-- `routing_decisions` is the record the timeline's `routed` event summarises
-- and the routing report reads, and `decided` is its last stage
-- (plans/ticket-category-routing.md, decision 5). A row decided with no
-- outcome is counted under no outcome at all, and one with no decided_at drops
-- out of time to decision — the figure the shadow week exists to measure, and
-- the one the window is tuned from. Neither failure says anything: the report
-- would simply be short.
--
-- Every writer in lib/routing sets them together: phase one writes the outcome
-- with the stage, and decided_at with it when nothing is owed after it; the
-- end of phase three coalesces decided_at over the outcome phase one wrote;
-- endHold writes an outcome when there is none yet and coalesces decided_at.
-- This is the half that also holds for an UPDATE nobody wrote a code path for
-- — a hand-run repair of a stuck window is the likely one — and for a writer
-- added later that moves the stage and forgets one of the two.
--
-- The enum value is safe to name here: db/sql replays after the migrations
-- commit, so routing_stage already exists.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'routing_decisions_decided_complete'
      AND conrelid = 'public.routing_decisions'::regclass
  ) THEN
    ALTER TABLE routing_decisions
      ADD CONSTRAINT routing_decisions_decided_complete CHECK (
        stage <> 'decided' OR (outcome IS NOT NULL AND decided_at IS NOT NULL)
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- A metrics_daily row is one slice: the totals, or one dimension
--
-- Null in a dimension means "all", so the totals row is the one with every
-- dimension null, and each other row names exactly one — a group, an agent, a
-- channel or a category (lib/reports/rollup.ts, slicesFor). Every reader
-- leans on that: a totals read selects the row with every dimension null
-- (TOTALS_SLICE in lib/reports/queries.ts), and a breakdown selects the rows
-- naming its own. A row naming two would be counted in both breakdowns, and
-- one naming none but sitting beside the totals would be a second totals row,
-- which every headline figure would add. The second is the unique key's to
-- refuse (metrics_daily_slice_key, NULLS NOT DISTINCT, in the schema); this is
-- the first, which no key can say.
--
-- It holds for every row production stored before category_id existed: the
-- four slices summed to every row on 2026-10-28, and none named two.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrics_daily_one_dimension'
      AND conrelid = 'public.metrics_daily'::regclass
  ) THEN
    ALTER TABLE metrics_daily
      ADD CONSTRAINT metrics_daily_one_dimension CHECK (
        num_nonnulls(group_id, agent_id, channel, category_id) <= 1
      );
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- agent_changes records a role or a sign-in address, and nothing else
--
-- The column is text so a third kind of change is one more value rather than
-- an enum migration, and this is what stops it being any text at all: a
-- reader asking "who changed this person's role?" filters on 'role', and a
-- row spelled 'Role' or 'roles' by a later writer would be a change that
-- question never finds. The one writer today is saveAgentProfile.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_changes_field_known'
      AND conrelid = 'public.agent_changes'::regclass
  ) THEN
    ALTER TABLE agent_changes
      ADD CONSTRAINT agent_changes_field_known CHECK (field IN ('role', 'email'));
  END IF;
END $$;
