import { DateTime } from 'luxon';
import { Columns, Meter, Sparkline, Stat } from '@/components/charts';
import { Card } from '@/components/ui';
import type { todayByHour, todaySoFar } from '@/lib/reports/live';
import { averageSeconds, formatDuration } from '@/lib/reports/queries';

import { Section, TableView, slaTone, type Point } from './section';

export function TodaySoFar({
  today,
  context,
  hasHistory,
  recent,
  windowFirstResponse,
  days,
  todaySla,
  firstResponseSla,
  hourly,
}: {
  today: Awaited<ReturnType<typeof todaySoFar>>;
  context: { zone: string };
  hasHistory: boolean;
  recent: Point[];
  windowFirstResponse: number | null;
  days: number;
  todaySla: number | null;
  firstResponseSla: number | null;
  hourly: Awaited<ReturnType<typeof todayByHour>>;
}) {
  return (
    <Section
      title="Today so far"
      hint={`${formatDay(today.day, context.zone)} — measured by the same code that writes tonight's rollup, so today's figure and tomorrow's report agree. Response times are working hours.`}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* The sparkline is what turns a live number into a judgement: four
              tickets is a quiet morning or a collapse depending entirely on the
              fortnight behind it, and the tile is the only place both fit. */}
        <Stat
          label="Created"
          value={today.bucket.ticketsCreated.toLocaleString('en-GB')}
          hint={
            hasHistory ? `${recent.map((point) => point.created).at(-1) ?? 0} yesterday` : undefined
          }
        >
          {hasHistory ? (
            <Sparkline
              values={recent.map((point) => point.created)}
              label={`Tickets created on each of the last ${recent.length} days`}
            />
          ) : null}
        </Stat>
        <Stat
          label="Resolved"
          value={today.bucket.ticketsResolved.toLocaleString('en-GB')}
          hint={
            hasHistory
              ? `${recent.map((point) => point.resolved).at(-1) ?? 0} yesterday`
              : undefined
          }
        >
          {hasHistory ? (
            <Sparkline
              values={recent.map((point) => point.resolved)}
              color="var(--series-2)"
              label={`Tickets resolved on each of the last ${recent.length} days`}
            />
          ) : null}
        </Stat>
        <Stat
          label="First response"
          value={formatDuration(
            averageSeconds(today.bucket.firstResponseSecondsSum, today.bucket.firstResponseCount),
          )}
          hint={`Mean of ${today.bucket.firstResponseCount.toLocaleString('en-GB')}${
            windowFirstResponse === null
              ? ''
              : ` · ${formatDuration(windowFirstResponse)} over ${days} days`
          }`}
        />
        <Stat
          label="First response within SLA"
          value={todaySla === null ? '—' : `${todaySla}%`}
          hint={
            firstResponseSla === null
              ? `Nothing to compare with yet over ${days} days`
              : `${firstResponseSla}% over ${days} days`
          }
        >
          <Meter
            value={todaySla}
            tone={slaTone(todaySla)}
            label="First response within SLA, today"
          />
        </Stat>
      </div>

      <Card className="mt-3">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Messages through the day</h3>
          <p className="text-xs text-[var(--muted-foreground)]">
            Hour by hour, in {context.zone.replace('_', ' ')}. Private notes are not counted.
          </p>
        </div>

        {hourly.length === 0 ? (
          <p className="py-6 text-center text-xs text-[var(--muted-foreground)]">
            Nothing has come in yet today.
          </p>
        ) : (
          <>
            <Columns
              caption="Inbound and outbound messages for each hour of today"
              labels={hourly.map((bucket) => String(bucket.hour).padStart(2, '0'))}
              tickEvery={hourly.length > 12 ? 3 : 2}
              series={[
                {
                  label: 'From customers',
                  values: hourly.map((bucket) => bucket.inbound),
                  color: 'var(--series-1)',
                },
                {
                  label: 'From us',
                  values: hourly.map((bucket) => bucket.outbound),
                  color: 'var(--series-2)',
                },
              ]}
              height={120}
            />
            <TableView
              summary="Messages by hour, as a table"
              head={['Hour', 'From customers', 'From us']}
              rows={hourly.map((bucket) => [
                `${String(bucket.hour).padStart(2, '0')}:00`,
                bucket.inbound.toLocaleString('en-GB'),
                bucket.outbound.toLocaleString('en-GB'),
              ])}
            />
          </>
        )}
      </Card>
    </Section>
  );
}

function formatDay(day: string, zone: string): string {
  return DateTime.fromISO(day, { zone }).toFormat('cccc d LLLL');
}
