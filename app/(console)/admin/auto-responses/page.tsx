import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import {
  listAnyHoliday,
  listAutoResponses,
  listGroupNames,
  listScheduleOptions,
} from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { AutoResponseEditor, NewAutoResponse } from './forms';

export const dynamic = 'force-dynamic';

/**
 * What the helpdesk says when a customer writes in and nobody is here.
 *
 * Its own screen rather than another automation rule, because the question it
 * answers is not "what should happen to this ticket" but "what do we say when we
 * are shut" — and the answer has to be per group, per channel and in two
 * languages, which is a table of messages rather than a condition tree.
 *
 * The hours themselves are not set here. A rule sends when the ticket's group is
 * outside *its* calendar, so the schedules on Business hours are the same ones
 * every SLA due date is counted against — which is why this page links there
 * rather than growing a second set of opening times that could disagree.
 */
export default async function AutoResponsesPage() {
  await requirePermission('admin.automations');

  const [rules, groupRows, schedules, anyHoliday] = await Promise.all([
    listAutoResponses(),
    listGroupNames(),
    listScheduleOptions(),
    listAnyHoliday(),
  ]);

  // A rule with no calendar behind it never fires, and nothing on this page
  // would show that: the message is written, the toggle is on, and the customer
  // gets silence. Said here rather than left to be discovered at 22:00.
  const hasDefault = schedules.some((schedule) => schedule.isDefault);

  // The holiday message is only ever reached through a date on a calendar, and
  // no calendar has one. Somebody writing an Eid message deserves to know that
  // before Eid rather than after it.
  const holidayTextWithoutHolidays =
    anyHoliday.length === 0 &&
    rules.some((rule) => rule.holidayBodyAr.trim() || rule.holidayBodyEn.trim());

  return (
    <>
      <PageHeader
        title="Out-of-hours replies"
        description="Sent once when a customer writes in outside their group’s working hours. The most specific rule wins: a channel beats a group, and a rule naming both beats either."
        actions={<NewAutoResponse groups={groupRows} />}
      />

      {!hasDefault ? (
        <Card className="mb-4 border-amber-500/40">
          <p className="text-sm">
            No schedule is marked as the company default, so no hour counts as out of hours and
            nothing on this page will send.{' '}
            <Link href="/admin/hours" className="font-medium text-brand-600 hover:underline">
              Set one on Business hours
            </Link>
            .
          </p>
        </Card>
      ) : null}

      {holidayTextWithoutHolidays ? (
        <Card className="mb-4 border-amber-500/40">
          <p className="text-sm">
            A holiday message is written, but no schedule has a single holiday on it — so the
            ordinary out-of-hours message is what will send on Eid.{' '}
            <Link href="/admin/hours" className="font-medium text-brand-600 hover:underline">
              Add the dates on Business hours
            </Link>
            .
          </p>
        </Card>
      ) : null}

      <div className="flex flex-col gap-4">
        {rules.map((rule) => (
          <Card key={rule.id}>
            <AutoResponseEditor rule={rule} groups={groupRows} />
          </Card>
        ))}
      </div>

      {rules.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          No out-of-hours reply yet. A customer who writes in at 22:00 hears nothing back until
          somebody opens the ticket in the morning.
        </p>
      ) : null}
    </>
  );
}
