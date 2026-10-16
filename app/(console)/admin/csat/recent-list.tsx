'use client';

import Link from 'next/link';
import { Badge, Cell, Row, Table } from '@/components/ui';
import { RelativeTime } from '@/components/relative-time';
import type { RecentSurvey } from '@/lib/csat';
import { describeSkip } from '@/lib/csat/skip-reasons';
import { ago, channelLabel } from '@/lib/format';

/**
 * The newest survey decisions, one row each.
 *
 * A client component because `RelativeTime` words its time through a function
 * child, and a server page cannot hand a function across the boundary — the
 * render throws the moment the list has a row, which is the moment the admin
 * needs the page. The rows are plain data and cross it as they are.
 */
export function RecentSurveyList({ rows }: { rows: RecentSurvey[] }) {
  return (
    <>
      <Table head={['Ticket', 'Channel', 'What happened', 'Rating', 'When']}>
        {rows.map((row) => (
          <Row key={row.id}>
            <Cell>
              <Link href={`/inbox/${row.number}`} className="underline">
                #{row.number}
              </Link>
            </Cell>
            <Cell className="text-xs text-(--color-text-secondary)">
              {row.channel ? channelLabel(row.channel) : '—'}
            </Cell>
            <Cell className="text-xs">
              {row.status === 'skipped' ? (
                <>
                  <Badge tone="neutral">Not sent</Badge>{' '}
                  <span className="text-(--color-text-secondary)">
                    {describeSkip(row.skipReason)}
                  </span>
                </>
              ) : row.status === 'answered' ? (
                <Badge tone="success">Answered</Badge>
              ) : row.status === 'expired' ? (
                <Badge tone="neutral">Replaced by a newer survey</Badge>
              ) : (
                <Badge tone="info">
                  Sent {row.delivery === 'email_link' ? 'by email' : 'as a message'}
                </Badge>
              )}
            </Cell>
            <Cell className="text-xs">{row.rating === null ? '—' : `${row.rating} / 5`}</Cell>
            <Cell className="text-xs text-(--color-text-secondary)">
              <RelativeTime at={row.createdAt}>{(relative) => ago(relative)}</RelativeTime>
            </Cell>
          </Row>
        ))}
      </Table>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-(--color-text-secondary)">
          Nothing yet. A decision is recorded for every ticket resolved while surveys are on.
        </p>
      ) : null}
    </>
  );
}
