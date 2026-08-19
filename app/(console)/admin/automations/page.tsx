import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, automationRules, cannedResponses, groups } from '@/db/schema';
import { Badge, Card, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { requirePermission } from '@/lib/auth/guard';
import { NewRule, RuleEditor } from './forms';
import { ticketFieldOptions } from '../field-options';

export const dynamic = 'force-dynamic';

const TRIGGER_LABEL: Record<string, string> = {
  on_create: 'When a ticket is created',
  on_update: 'When a ticket is updated',
  time_based: 'On a schedule',
};

const TRIGGER_HINT: Record<string, string> = {
  on_create: 'Runs once, as the ticket arrives.',
  on_update: 'Runs when an agent changes a ticket or the customer replies.',
  time_based: 'Swept every fifteen minutes, for rules about elapsed time.',
};

/**
 * Automation rules — Freshdesk's Dispatch'r, Observer and Supervisor.
 *
 * Grouped by trigger, because that is the only thing that makes two rules
 * behave differently, and ordered within each group, because that is the order
 * they run in and `stop processing` makes the order load-bearing.
 */
export default async function AutomationsPage() {
  await requirePermission('admin.automations');

  const [rules, agentList, groupList, canned, fieldOptions] = await Promise.all([
    db
      .select()
      .from(automationRules)
      .orderBy(asc(automationRules.trigger), asc(automationRules.position)),
    db
      .select({ id: agents.id, name: agents.name, email: agents.email })
      .from(agents)
      .where(eq(agents.isActive, true))
      .orderBy(asc(agents.name)),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name)),
    db
      .select({ id: cannedResponses.id, title: cannedResponses.title })
      .from(cannedResponses)
      .orderBy(asc(cannedResponses.title)),
    ticketFieldOptions(),
  ]);

  const agentChoices = agentList.map((agent) => ({
    value: agent.id,
    label: agent.name ?? agent.email,
  }));
  const groupChoices = groupList.map((group) => ({ value: group.id, label: group.name }));
  const cannedChoices = canned.map((response) => ({
    value: response.id,
    label: response.title,
  }));

  const builderProps = {
    agents: agentChoices,
    groups: groupChoices,
    cannedResponses: cannedChoices,
    fields: fieldOptions,
  };

  return (
    <>
      <PageHeader
        title="Automations"
        description="Rules that act on tickets for you. They run in order and a rule that stops processing ends the run for that ticket."
        actions={<NewRule {...builderProps} />}
      />

      <div className="flex flex-col gap-6">
        {(['on_create', 'on_update', 'time_based'] as const).map((trigger) => {
          const forTrigger = rules.filter((rule) => rule.trigger === trigger);

          return (
            <section key={trigger}>
              <h2 className="text-sm font-semibold">{TRIGGER_LABEL[trigger]}</h2>
              <p className="mb-2 text-xs text-[var(--muted-foreground)]">{TRIGGER_HINT[trigger]}</p>

              {forTrigger.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)]">
                  No rules here yet.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {forTrigger.map((rule) => (
                    <Card key={rule.id}>
                      <RuleEditor
                        rule={rule}
                        {...builderProps}
                        lastRun={rule.lastRunAt ? formatDateTime(rule.lastRunAt) : null}
                      />
                    </Card>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <p className="mt-6 text-xs text-[var(--muted-foreground)]">
        <Badge tone="neutral">Note</Badge> Actions write to the ticket directly and never re-enter
        the engine, so a rule cannot trigger another rule.
      </p>
    </>
  );
}
