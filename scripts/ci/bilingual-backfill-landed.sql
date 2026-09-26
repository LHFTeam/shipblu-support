-- After the replay: the backfill landed, and in the right language, and left
-- alone the row that had already been written. Seeded by
-- bilingual-backfill-seed.sql; the reasoning is beside the step in ci.yml.
--
-- Run with `psql -v ON_ERROR_STOP=1`, so a RAISE EXCEPTION fails the job.

do $$
begin
  if (select body_text_ar from canned_responses where title = 'arabic') = '' then
    raise exception 'the Arabic response was not backfilled';
  end if;
  if (select body_text_en from canned_responses where title = 'arabic') <> '' then
    raise exception 'the Arabic response was filed as English';
  end if;
  if (select body_text_en from canned_responses where title = 'english') = '' then
    raise exception 'the English response was not backfilled';
  end if;
  if (select body_text_en from canned_responses where title = 'edited') <> 'kept' then
    raise exception 'the backfill overwrote a row that had already been written';
  end if;
  if (select name_en from holidays where date = '2026-03-22') <> 'Eid al-Fitr' then
    raise exception 'the holiday name was not backfilled';
  end if;
end
$$;
