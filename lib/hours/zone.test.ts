import { expect, it } from 'vitest';
import { businessHours } from '@/db/schema/config';
import { TEAM_TIME_ZONE } from './zone';

// The column's default is a literal in a generated migration, so it cannot
// import the constant. This keeps a schedule inserted by SQL and one created in
// the console starting in the same zone.
it('is the zone a schedule row defaults to', () => {
  expect(businessHours.timezone.default).toBe(TEAM_TIME_ZONE);
});
