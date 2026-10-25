import { Notice, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { categoryUsage, listCategories } from '@/lib/categories/queries';
import { routeGroupSummaries } from '@/lib/categories/route-groups';
import { CategoriesTable, NewCategory } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Ticket categories: which team's work a ticket is.
 *
 * One per ticket, set by an agent or a rule — beside the subcategories, which
 * say what a ticket is about and can be several. A category is a routing label,
 * never a statement about who the customer is, so nothing here touches
 * `requester_kind` (`plans/ticket-category-routing.md`, decision 3).
 *
 * The route group is chosen here once and then acted on with nobody watching:
 * from Stage 5 a channel that routes by category sends each fresh ticket to it.
 * So the picker says, for whichever group is chosen, how that group hands work
 * out and how many of its people are there to take it, and warns when the
 * answer is nobody (`lib/categories/route-groups.ts`).
 *
 * Nothing on this page deletes. `conversations.category_id` is `restrict`, and
 * a retired category keeps every ticket filed under it.
 */
export default async function CategoriesPage() {
  await requirePermission('admin.categories');

  const [categories, usage, routeGroups] = await Promise.all([
    listCategories(),
    categoryUsage(),
    routeGroupSummaries(),
  ]);

  // One past the last, so a new category lands at the end of every picker
  // unless the admin says otherwise; 0 would put it first.
  const nextPosition = Math.max(-1, ...categories.map((category) => category.position)) + 1;

  return (
    <>
      <PageHeader
        title="Categories"
        description="Which team's work a ticket is: one per ticket, set by an agent or a rule. It says which team answers, not who the customer is. Once a channel routes by category, a new ticket goes to its category's route group. Categories are retired, never deleted, and a key never changes once created."
        actions={<NewCategory routeGroups={routeGroups} nextPosition={nextPosition} />}
      />

      {categories.length === 0 ? (
        <Notice tone="neutral">
          No categories yet. Run <code>npm run job -- seed_ticket_categories</code> to add the
          starter set — it is defined in <code>lib/categories/registry.ts</code> — or add one here.
        </Notice>
      ) : (
        <CategoriesTable
          rows={categories.map((category) => ({
            ...category,
            tickets: usage.get(category.id) ?? 0,
          }))}
          routeGroups={routeGroups}
        />
      )}
    </>
  );
}
