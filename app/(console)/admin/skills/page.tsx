import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentSkills, agents, groups, skills } from '@/db/schema';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { NewSkill, SkillEditor } from './forms';
import { ticketFieldOptions } from '../field-options';

export const dynamic = 'force-dynamic';

/**
 * Skills — what a ticket needs somebody to be able to do.
 *
 * A skill is inert on its own. It does something only when a group is set to
 * match skills, and the note at the top of this page says so, because a skill
 * carefully configured against a group that distributes by plain round robin is
 * a setting that appears to do nothing for no visible reason.
 */
export default async function SkillsPage() {
  await requirePermission('admin.skills');

  const [rows, agentList, fields, routingGroups] = await Promise.all([
    db.select().from(skills).orderBy(asc(skills.position), asc(skills.name)),
    db
      .select({ id: agents.id, name: agents.name, email: agents.email })
      .from(agents)
      .where(eq(agents.isActive, true))
      .orderBy(asc(agents.name)),
    ticketFieldOptions(),
    db
      .select({ name: groups.name })
      .from(groups)
      .where(eq(groups.matchSkills, true))
      .orderBy(asc(groups.name)),
  ]);

  const holders = rows.length
    ? await db
        .select({ skillId: agentSkills.skillId, agentId: agentSkills.agentId })
        .from(agentSkills)
        .where(
          inArray(
            agentSkills.skillId,
            rows.map((row) => row.id),
          ),
        )
    : [];

  const bySkill = new Map<string, string[]>();
  for (const row of holders) {
    bySkill.set(row.skillId, [...(bySkill.get(row.skillId) ?? []), row.agentId]);
  }

  const agentChoices = agentList.map((agent) => ({
    value: agent.id,
    label: agent.name || agent.email,
  }));

  return (
    <>
      <PageHeader
        title="Skills"
        description="What a ticket needs somebody to be able to do — a language, a product area, a tier. A ticket that matches a skill is only offered to agents who hold it."
        actions={<NewSkill fields={fields} agents={agentChoices} />}
      />

      <p className="mb-3 text-xs text-[var(--muted-foreground)]">
        {routingGroups.length === 0
          ? 'No group matches on skills yet, so nothing here affects where a ticket goes. Turn on “Match skills first” for a group under Groups.'
          : `Used by ${routingGroups.map((group) => group.name).join(', ')}.`}
      </p>

      <div className="flex flex-col gap-2">
        {rows.map((skill) => (
          <Card key={skill.id}>
            <SkillEditor
              skill={{ ...skill, agentIds: bySkill.get(skill.id) ?? [] }}
              fields={fields}
              agents={agentChoices}
            />
          </Card>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No skills yet"
          hint="Without any, a group that matches on skills behaves exactly as one that does not: every member is a candidate for every ticket."
        />
      ) : null}
    </>
  );
}
