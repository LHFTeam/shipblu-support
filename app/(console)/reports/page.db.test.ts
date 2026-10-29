import { eq } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { groups, metricsDaily, ticketCategories } from '@/db/schema';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';
import { withCleanDatabase } from '@/lib/testing/db';
import ReportsPage from './page';

/**
 * The overview as it renders against the database, for what no query test can
 * see: which columns each breakdown draws. Rendered to static markup with the
 * session stubbed, as the routing report's page test does.
 */

vi.mock('@/lib/auth/guard', () => ({
  requireAgent: () => Promise.resolve({ id: 'viewer', role: 'admin', permissions: {} }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

withCleanDatabase();

/** The markup of one breakdown, from its heading to the end of its section. */
function section(html: string, title: string): string {
  const at = html.indexOf(`>${title}<`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf('</section>', at));
}

describe('the reports overview', () => {
  // A survey records the group, agent and channel it was asked under but no
  // category, so a score filed by category would move with every relabel:
  // every other CSAT stays where the survey was asked.
  it('draws no CSAT by category, which a survey keeps no snapshot of', async () => {
    const { zone } = await reportingContext();
    const day = rangeIn(zone, 30).from;
    const [sales] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, 'sales'));
    const [deliveries] = await db
      .insert(groups)
      .values({ name: 'Deliveries' })
      .returning({ id: groups.id });
    const answered = { ticketsCreated: 1, csatResponseCount: 1, csatRatingSum: 2, csatRating2: 1 };
    await db.insert(metricsDaily).values([
      { day, ...answered },
      { day, channel: 'email', ...answered },
      { day, categoryId: sales!.id, ...answered },
      { day, groupId: deliveries!.id, ...answered },
    ]);

    const page = await ReportsPage({ searchParams: Promise.resolve({ days: '30' }) });
    const html = renderToStaticMarkup(createElement('div', null, page));

    expect(section(html, 'By group')).toMatch(/>CSAT</);
    expect(section(html, 'By group')).toMatch(/>2\.0</);
    expect(section(html, 'By category')).not.toMatch(/>CSAT</);
    expect(section(html, 'By category')).not.toMatch(/>2\.0</);
  });
});
