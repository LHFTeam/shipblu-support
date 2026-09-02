import Link from 'next/link';
import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketCategories, ticketRootCauses } from '@/db/schema';
import { PageHeader, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requirePermission } from '@/lib/auth/guard';
import { categoryUsage } from '@/lib/categorise/seed';
import { CategoryRow, RootCauseRow } from './forms';

export const dynamic = 'force-dynamic';

/**
 * The taxonomy: what a ticket can be about, and why it can have happened.
 *
 * Editable here rather than in code because renaming "Cost and payment methods"
 * to "Pricing" is a decision by whoever owns the report and should not need a
 * deploy. What is **not** editable here is the matching — which words mean which
 * category lives in `lib/categorise/rules.ts`, compiled, with tests. A regular
 * expression typed into a form is a production incident with no review.
 *
 * Nothing on this page deletes. The foreign key from `conversation_categories`
 * is `restrict`, so a category with tickets behind it cannot be removed at all —
 * it is deactivated, which takes it out of the picker and leaves every report
 * ever drawn from it still readable.
 */
export default async function CategoriesPage() {
  await requirePermission('admin.categories');

  const [categories, causes, usage] = await Promise.all([
    db
      .select()
      .from(ticketCategories)
      .orderBy(asc(ticketCategories.position), asc(ticketCategories.key)),
    db
      .select()
      .from(ticketRootCauses)
      .orderBy(asc(ticketRootCauses.position), asc(ticketRootCauses.key)),
    categoryUsage(),
  ]);

  /*
   * Which detectable categories have never been assigned.
   *
   * Only worth saying once something *has* been assigned. On a system where
   * nothing has run yet every category is unused, and listing all of them is
   * not a finding — it is the same sentence as "no tickets yet", spelled out
   * fifty times. `usage.size` is the test for that.
   */
  const unused =
    usage.size === 0
      ? []
      : categories.filter(
          (category) => category.isActive && category.isDetectable && !usage.get(category.key),
        );

  return (
    <>
      <PageHeader
        title="Categories and causes"
        description="What tickets are about, and why they happen. Labels are yours to change; which words match which category lives in code, with tests."
        actions={
          <Link
            href="/admin/categories/review"
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--muted)]"
          >
            Review queue
          </Link>
        }
      />

      {categories.length === 0 ? (
        <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm opacity-70">
          No taxonomy yet. Run <code>npm run db:seed</code> to create it — the categories and causes
          are defined in <code>lib/categorise/taxonomy.ts</code> and seeded from there.
        </p>
      ) : (
        <>
          {/*
            Not a warning, an observation — a category at zero is either one
            nobody needs or a rule that never matches, and only the second is a
            problem. Saying which is which is what `is_detectable` is for, so
            manual-only categories are left out of this count entirely.
          */}
          {unused.length > 0 ? (
            <p className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <b>{unused.length}</b> detectable categories have never been assigned:{' '}
              {unused.map((category) => category.key).join(', ')}. Either the rules for them never
              match, or nobody raises them — the review queue&rsquo;s rule table tells the two
              apart.
            </p>
          ) : null}

          <h2 className="mb-2 text-sm font-medium">What tickets are about</h2>
          <Table
            head={[
              'Category',
              <>
                Key{' '}
                <InfoTip label="Key">
                  How the category is named everywhere it is not shown to a person: every compiled
                  rule awards one, every stored assignment freezes one, and every report groups by
                  one. Fixed once the category exists — renaming it would leave the rules pointing
                  at nothing and strand the value on every ticket already filed under it.
                </InfoTip>
              </>,
              'Arabic',
              <>
                Who{' '}
                <InfoTip label="Who">
                  Which population raises this. It <b>orders</b> the picker an agent sees — a
                  recipient&rsquo;s delivery questions above a merchant&rsquo;s payout ones on a
                  recipient&rsquo;s ticket — and never hides a row, because the ticket&rsquo;s
                  requester is established from role flags that can be absent or stale. A list of
                  fifty is one where people choose the first plausible row; a list an agent cannot
                  reach past is worse.
                </InfoTip>
              </>,
              'Used',
              '',
            ]}
          >
            {categories.map((category) => (
              <CategoryRow
                key={category.id}
                category={{
                  id: category.id,
                  key: category.key,
                  area: category.area,
                  labelEn: category.labelEn,
                  labelAr: category.labelAr,
                  audience: category.audience,
                  isActive: category.isActive,
                  isDetectable: category.isDetectable,
                }}
                used={usage.get(category.key) ?? 0}
              />
            ))}
          </Table>

          <h2 className="mt-8 mb-2 text-sm font-medium">Why tickets happen</h2>
          <p className="mb-3 max-w-2xl text-sm opacity-70">
            Recorded by the agent who resolves a ticket, never detected — the customer reports a
            symptom and does not know the cause. Each one names exactly one accountable party, so an
            agent answers one question and the report gets both dimensions.
          </p>
          <Table head={['Cause', 'Key', 'Arabic', 'Owner', '']}>
            {causes.map((cause) => (
              <RootCauseRow
                key={cause.id}
                cause={{
                  id: cause.id,
                  key: cause.key,
                  labelEn: cause.labelEn,
                  labelAr: cause.labelAr,
                  owner: cause.owner,
                  isActive: cause.isActive,
                }}
              />
            ))}
          </Table>
        </>
      )}
    </>
  );
}
