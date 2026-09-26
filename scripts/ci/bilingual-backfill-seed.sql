-- Rows in the shape the bilingual backfill exists for, seeded by the database
-- job before it replays db/sql: content in the superseded column and the pair
-- still at its default, which is what every row looked like the moment
-- migration 0025 finished. The reasoning is beside the step in ci.yml.
--
-- Run with `psql -v ON_ERROR_STOP=1`.

insert into business_hours (name, schedule) values ('CI', '{}'::jsonb);
insert into holidays (business_hours_id, date, name)
  select id, date '2026-03-22', 'Eid al-Fitr' from business_hours limit 1;
insert into canned_responses (title, body_text, body_html) values
  ('arabic', 'الشحنة في الطريق إليك', '<p>الشحنة في الطريق إليك</p>'),
  ('english', 'Your parcel is on its way', '<p>Your parcel is on its way</p>'),
  ('edited',  'superseded', '<p>superseded</p>');
-- Already migrated by hand: the backfill must leave it alone.
update canned_responses set body_text_en = 'kept', body_html_en = '<p>kept</p>'
 where title = 'edited';
