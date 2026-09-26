-- After a second replay: an edit made in the console since the backfill is
-- still there. The guard is "both sides blank", not "the legacy column exists",
-- and this is the case that tells the two apart.
--
-- Run with `psql -v ON_ERROR_STOP=1`, so a RAISE EXCEPTION fails the job.

do $$
begin
  if (select body_text_ar from canned_responses where title = 'arabic')
     <> 'edited in the console' then
    raise exception 'the replay overwrote an edit made after the backfill';
  end if;
end
$$;
