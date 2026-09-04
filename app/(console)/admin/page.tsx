import Link from 'next/link';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  automationRules,
  businessHours,
  cannedResponses,
  channels,
  groups,
  locations,
  skills,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import { Badge, Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';

export const dynamic = 'force-dynamic';

/** ShipBlu's location count, and the only reason this page can say "the rest". */
const LOCATIONS_EXPECTED = 16;

/**
 * Settings overview.
 *
 * Deliberately not a dashboard of numbers. The useful thing to say on this page
 * is which pieces of configuration are missing, because each absence has a
 * consequence that is invisible until someone notices it weeks later — no SLA
 * policy means no ticket ever has a due date, and no business hours means every
 * target is counted through the night.
 */
export default async function AdminIndexPage() {
  await requirePermission('admin.agents');

  const [counts] = await db
    .select({
      agents: sql<number>`(select count(*)::int from ${agents} where is_active)`,
      policies: sql<number>`(select count(*)::int from ${slaPolicies} where is_active)`,
      defaultPolicy: sql<number>`(select count(*)::int from ${slaPolicies} where is_default and is_active)`,
      rules: sql<number>`(select count(*)::int from ${automationRules} where is_active)`,
      schedules: sql<number>`(select count(*)::int from ${businessHours})`,
      statuses: sql<number>`(select count(*)::int from ${ticketStatuses})`,
      canned: sql<number>`(select count(*)::int from ${cannedResponses})`,
      channels: sql<number>`(select count(*)::int from ${channels} where is_active)`,
      locations: sql<number>`(select count(*)::int from ${locations})`,
      routingGroups: sql<number>`(select count(*)::int from ${groups} where assignment_strategy <> 'manual')`,
      allGroups: sql<number>`(select count(*)::int from ${groups})`,
      // A skill that no active agent holds, on a group that routes by skill, is
      // a ticket that waits for the timeout and then goes to anybody — or waits
      // forever, if nobody set one. Counted here because it is invisible
      // everywhere else until a customer chases.
      orphanSkills: sql<number>`(
        select count(*)::int from ${skills} s
        where s.is_active
          and not exists (
            select 1 from ${agentSkills} a
            join ${agents} g on g.id = a.agent_id and g.is_active
            where a.skill_id = s.id
          )
      )`,
    })
    .from(sql`(select 1) as one`);

  void eq;

  const checks = [
    {
      ok: (counts?.policies ?? 0) > 0 && (counts?.defaultPolicy ?? 0) > 0,
      href: '/admin/sla',
      title: 'SLA policies',
      good: `${counts?.policies} active, with a default`,
      bad:
        (counts?.policies ?? 0) === 0
          ? 'None — no ticket has a due date, and the breach sweep has nothing to find'
          : 'No default policy — a ticket matching nothing gets no targets at all',
    },
    {
      ok: (counts?.routingGroups ?? 0) > 0 && (counts?.orphanSkills ?? 0) === 0,
      optional: (counts?.routingGroups ?? 0) === 0,
      href: '/admin/groups',
      title: 'Ticket assignment',
      good: `${counts?.routingGroups} of ${counts?.allGroups} group(s) assign automatically`,
      bad:
        (counts?.orphanSkills ?? 0) > 0
          ? `${counts?.orphanSkills} skill(s) no active agent holds — tickets needing one wait for the skill timeout`
          : 'Every group is on manual — tickets wait in the queue until somebody picks them up',
    },
    {
      ok: (counts?.schedules ?? 0) > 0,
      href: '/admin/hours',
      title: 'Business hours',
      good: `${counts?.schedules} schedule(s)`,
      bad: 'None — SLA targets and response times are counted through the night',
    },
    {
      ok: (counts?.channels ?? 0) > 0,
      href: '/admin/channels',
      title: 'Channels',
      good: `${counts?.channels} active`,
      bad: 'None configured — tickets still arrive, but with no default group',
    },
    {
      // Sixteen is the number, and a register stuck at fourteen is the failure
      // this row exists to make visible — a missing hub reads as a hub that does
      // not exist. Optional because nothing routes on a location yet.
      ok: (counts?.locations ?? 0) >= LOCATIONS_EXPECTED,
      href: '/admin/locations',
      title: 'Locations',
      good: `${counts?.locations} entered`,
      bad:
        (counts?.locations ?? 0) === 0
          ? `None of the ${LOCATIONS_EXPECTED} ShipBlu locations have been entered`
          : `${counts?.locations} of ${LOCATIONS_EXPECTED} entered — the rest look like locations that do not exist`,
      optional: true,
    },
    {
      ok: (counts?.rules ?? 0) > 0,
      href: '/admin/automations',
      title: 'Automations',
      good: `${counts?.rules} active rule(s)`,
      bad: 'None — every ticket is triaged by hand',
      optional: true,
    },
    {
      ok: (counts?.canned ?? 0) > 0,
      href: '/admin/canned',
      title: 'Canned responses',
      good: `${counts?.canned} saved`,
      bad: 'None — automations have nothing to send as an acknowledgement',
      optional: true,
    },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description="How work reaches your team, what it promises the customer, and what the customer sees."
        actions={
          <Link href="/admin/dashboard" className="text-sm text-brand-600 hover:underline">
            Live dashboard →
          </Link>
        }
      />

      <div className="flex flex-col gap-2">
        {checks.map((check) => (
          <Link key={check.href} href={check.href}>
            <Card className="flex items-center gap-3 transition-colors hover:border-brand-500/40">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{check.title}</span>
                <span className="block text-xs text-[var(--muted-foreground)]">
                  {check.ok ? check.good : check.bad}
                </span>
              </span>
              {check.ok ? (
                <Badge tone="success">ready</Badge>
              ) : check.optional ? (
                <Badge tone="neutral">optional</Badge>
              ) : (
                <Badge tone="warning">needs setting up</Badge>
              )}
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-[var(--muted-foreground)]">Active agents</p>
          <p className="text-2xl font-semibold">{counts?.agents ?? 0}</p>
        </Card>
        <Card>
          <p className="text-xs text-[var(--muted-foreground)]">Ticket statuses</p>
          <p className="text-2xl font-semibold">{counts?.statuses ?? 0}</p>
        </Card>
        <Card>
          <p className="text-xs text-[var(--muted-foreground)]">Automation rules</p>
          <p className="text-2xl font-semibold">{counts?.rules ?? 0}</p>
        </Card>
      </div>
    </>
  );
}
