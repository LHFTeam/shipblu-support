-- Post-migration SQL: the `app_roles` events Meta delivered before
-- `process_meta_webhook` stored them.
--
-- Migration 0058 created `meta_app_role_events`, and from this release the
-- worker records each `app_roles` event as it processes the delivery
-- (`recordAppRole`, `lib/meta/app-roles.ts`). The ones that came before are
-- only in `webhook_events`, which the nightly cleanup empties after thirty days.
-- Production holds two, both from 2026-11-05: the Page's at 10:30:12 UTC and
-- the Instagram account's at 10:30:24, the switch that made this app the
-- account's default app. The thread verdict reads that switch as superseding
-- every Instagram `standby` older than it (`docs/PROJECT-STATE.md` §6.111), and
-- its delivery is deleted on about 2026-12-05. A deploy before then copies it.
--
-- Read the way `parseMetaWebhook` reads one, rule for rule, because the two
-- write the same rows and the unique key must take them as one:
--
-- - only a verified delivery, as `process_webhook` processes nothing else: an
--   unsigned POST naming this app the default would otherwise unblock replies;
-- - `page` is `facebook`, `instagram` is itself, any other object is nothing;
-- - events from `messaging` and from `standby` both;
-- - an entry or an event that is not an object, and a list that is not an
--   array, holds nothing;
-- - the account is the entry's id, else the event's recipient, either only as
--   a non-empty string;
-- - one row per app the event names, its roles the strings listed, a single
--   string read as a list of one, anything else left out;
-- - the instant is the event's timestamp, else the entry's time: seconds below
--   10^12 and milliseconds above, in float8 as JavaScript's numbers are,
--   truncated to the millisecond as a `Date` is, and taken only after 1970 and
--   before 3000 (`storableInstant`). An event with neither is left out rather
--   than dated now.
--
-- **This file must never raise**, since a replay that fails stops every
-- deploy until the delivery ages out. So nothing is cast before its type is
-- checked, each check in a CASE of its own (Postgres does not promise the order
-- in which the halves of an AND are evaluated), a number is range-checked as
-- numeric before it becomes a float8 (which refuses 1e-400), and only an
-- instant inside the window becomes a bigint and an interval, where a thousand
-- times it is exact.
--
-- `meta-app-role-backfill.db.test.ts` holds the two to one answer on every one
-- of those shapes.
--
-- Every replay reads every such delivery still stored. `@?` finds them through
-- the provider index without rendering each payload as text: 6.5 ms over
-- production's 1,705 Meta deliveries, against 1.3 s for a LIKE on the text. So
-- a switch delivered while a deploy is under way — processed by the release
-- going out, which stores nothing — is still copied on the next one, while it
-- is stored. `ON CONFLICT DO NOTHING` makes the replay idempotent, and the worker
-- recording a delivery this has already copied, or the other way round, inserts
-- nothing either.
--
-- No lock beyond what an insert needs: ROW EXCLUSIVE on `meta_app_role_events`
-- and a read of `webhook_events`, neither of which a writer or a vacuum waits on
-- (#471's replay-locks test).
insert into meta_app_role_events (platform, account_id, app_id, roles, at, webhook_event_id)
select
  case w.payload->>'object' when 'page' then 'facebook' else 'instagram' end,
  account.id,
  role.key,
  array(
    select listed.value #>> '{}'
    from jsonb_array_elements(
      case jsonb_typeof(role.value) when 'array' then role.value else jsonb_build_array(role.value) end
    ) with ordinality as listed(value, n)
    where jsonb_typeof(listed.value) = 'string' and listed.value #>> '{}' <> ''
    order by listed.n
  ),
  timestamptz 'epoch' + stamp.ms::bigint * interval '1 millisecond',
  w.id
from webhook_events w
cross join lateral jsonb_array_elements(
  case jsonb_typeof(w.payload->'entry') when 'array' then w.payload->'entry' else '[]'::jsonb end
) as entry(value)
cross join lateral (
  select value
  from jsonb_array_elements(
    case jsonb_typeof(entry.value->'messaging')
      when 'array' then entry.value->'messaging'
      else '[]'::jsonb
    end
  )
  union all
  select value
  from jsonb_array_elements(
    case jsonb_typeof(entry.value->'standby')
      when 'array' then entry.value->'standby'
      else '[]'::jsonb
    end
  )
) as event(value)
cross join lateral jsonb_each(
  case jsonb_typeof(event.value->'app_roles')
    when 'object' then event.value->'app_roles'
    else '{}'::jsonb
  end
) as role(key, value)
cross join lateral (
  select coalesce(
    case
      when jsonb_typeof(entry.value->'id') = 'string' then nullif(entry.value->>'id', '')
    end,
    case
      when jsonb_typeof(event.value->'recipient'->'id') = 'string'
      then nullif(event.value->'recipient'->>'id', '')
    end
  ) as id
) as account
cross join lateral (
  select converted.ms
  from (values (1, event.value->'timestamp'), (2, entry.value->'time')) as given(n, raw)
  cross join lateral (
    select
      case when jsonb_typeof(given.raw) = 'number' then
        case
          when (given.raw #>> '{}')::numeric > 1e-300 and (given.raw #>> '{}')::numeric < 1e300
          then trunc(
            case
              when (given.raw #>> '{}')::float8 < 1e12 then (given.raw #>> '{}')::float8 * 1000
              else (given.raw #>> '{}')::float8
            end
          )
        end
      end as ms
  ) as converted
  where converted.ms > 0 and converted.ms < 32503680000000
  order by given.n
  limit 1
) as stamp
where w.provider = 'meta'
  and w.signature_verified
  and w.payload->>'object' in ('page', 'instagram')
  and (
    w.payload @? '$.entry[*].messaging[*].app_roles'
    or w.payload @? '$.entry[*].standby[*].app_roles'
  )
  and role.key <> ''
  and account.id is not null
on conflict (platform, account_id, at, app_id) do nothing;
