import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, businessHours, slaPolicies } from '@/db/schema';
import { Badge, Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { NewPolicy, PolicyEditor } from './forms';
import { ticketFieldOptions } from '../field-options';

export const dynamic = 'force-dynamic';

/**
 * SLA policies.
 *
 * Ordered, because that is how the engine picks one: the first policy whose
 * conditions match wins, and the default applies when nothing does. The list is
 * shown in that order so an admin can read it the way the sweep will.
 */
export default async function SlaPage() {
  await requirePermission('admin.sla');

  const [policies, schedules, agentList, fieldOptions] = await Promise.all([
    db.select().from(slaPolicies).orderBy(asc(slaPolicies.position), asc(slaPolicies.name)),
    db.select({ id: businessHours.id, name: businessHours.name }).from(businessHours),
    db
      .select({ id: agents.id, name: agents.name, email: agents.email })
      .from(agents)
      .where(eq(agents.isActive, true))
      .orderBy(asc(agents.name)),
    ticketFieldOptions(),
  ]);

  const agentChoices = agentList.map((agent) => ({
    value: agent.id,
    label: agent.name ?? agent.email,
  }));
  const scheduleChoices = schedules.map((schedule) => ({
    value: schedule.id,
    label: schedule.name,
  }));

  return (
    <>
      <PageHeader
        title="SLA policies"
        description="Response and resolution targets. The first policy whose conditions match a ticket wins, so order matters; the default applies when none do."
        actions={
          <NewPolicy
            schedules={scheduleChoices}
            agents={agentChoices}
            fields={fieldOptions}
            nextPosition={policies.length + 1}
          />
        }
      />

      <div className="flex flex-col gap-3">
        {policies.map((policy) => (
          <Card key={policy.id}>
            <PolicyEditor
              policy={policy}
              schedules={scheduleChoices}
              agents={agentChoices}
              fields={fieldOptions}
              scheduleName={
                schedules.find((schedule) => schedule.id === policy.businessHoursId)?.name ?? null
              }
            />
          </Card>
        ))}
      </div>

      {policies.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--muted-foreground)]">
            No policies yet, so no ticket has a due date and the breach sweep has nothing to find.
            Start with one default policy covering every ticket.
          </p>
        </Card>
      ) : (
        <p className="mt-4 text-xs text-[var(--muted-foreground)]">
          {policies.some((policy) => policy.isDefault) ? null : (
            <Badge tone="warning">
              No default policy — tickets matching nothing get no targets at all
            </Badge>
          )}
        </p>
      )}
    </>
  );
}
