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
-- - the account is the entry's id, else the event's recipient, and never '';
-- - one row per app the event names, its roles the strings listed, a single
--   string read as a list of one, anything else left out;
-- - the instant is the event's timestamp, else the entry's time, seconds below
--   10^12 and milliseconds above, truncated to the millisecond as a JavaScript
--   `Date` is, and an event with neither is left out rather than dated now.
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
  coalesce(entry.value->>'id', event.value->'recipient'->>'id'),
  role.key,
  array(
    select listed.value #>> '{}'
    from jsonb_array_elements(
      case jsonb_typeof(role.value) when 'array' then role.value else jsonb_build_array(role.value) end
    ) with ordinality as listed(value, n)
    where jsonb_typeof(listed.value) = 'string' and listed.value #>> '{}' <> ''
    order by listed.n
  ),
  timestamptz 'epoch'
    + trunc(case when stamp.value < 1e12 then stamp.value * 1000 else stamp.value end)::bigint
      * interval '1 millisecond',
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
      when jsonb_typeof(event.value->'timestamp') = 'number'
        and (event.value->>'timestamp')::numeric <> 0
      then (event.value->>'timestamp')::numeric
    end,
    case
      when jsonb_typeof(entry.value->'time') = 'number' and (entry.value->>'time')::numeric <> 0
      then (entry.value->>'time')::numeric
    end
  ) as value
) as stamp
where w.provider = 'meta'
  and w.signature_verified
  and w.payload->>'object' in ('page', 'instagram')
  and (
    w.payload @? '$.entry[*].messaging[*].app_roles'
    or w.payload @? '$.entry[*].standby[*].app_roles'
  )
  and role.key <> ''
  and coalesce(entry.value->>'id', event.value->'recipient'->>'id') <> ''
  and stamp.value is not null
on conflict (platform, account_id, at, app_id) do nothing;
