-- The console handbook's audience, after `seed_console_handbook`: every folder
-- internal, and every role on the ladder addressed. A folder that lost its
-- floor is how a supervisor article reaches every agent.
--
-- Run with `psql -v ON_ERROR_STOP=1`, so a RAISE EXCEPTION fails the job.

do $$
declare wrong int;
begin
  select count(*) into wrong from kb_folders
    where external_id like 'handbook:folder:%'
      and (visibility <> 'agents_only' or min_role is null);
  if wrong > 0 then
    raise exception '% handbook folder(s) are not internal or carry no role floor', wrong;
  end if;

  select count(distinct min_role) into wrong from kb_folders
    where external_id like 'handbook:folder:%';
  if wrong <> 4 then
    raise exception 'handbook folders cover % of the 4 roles', wrong;
  end if;
end
$$;
