import Link from 'next/link';
import { Notice, PageHeader } from '@/components/ui';
import { configurationCounts } from '@/lib/admin/overview';
import { requireAnyPermission } from '@/lib/auth/guard';
import { SettingsDirectory, type DirectoryStatus } from './directory';
import { SETTINGS_PERMISSIONS, sectionsFor } from './sections';

export const dynamic = 'force-dynamic';

/**
 * Settings home: every page this agent may open, grouped as the sidebar groups
 * them, with a search — and, on the pages where an absence matters, whether it
 * is set up.
 *
 * Deliberately not a dashboard of numbers. The useful thing to say beside a
 * page is whether a piece of configuration is missing, because each absence
 * has a consequence that is invisible until someone notices it weeks later —
 * no SLA policy means no ticket ever has a due date, and no business hours
 * means every target is counted through the night. So the checks ride on the
 * card for the page that fixes them, and the ones that need doing are repeated
 * above the search, where they cannot scroll out of sight.
 */
export default async function AdminIndexPage() {
  const agent = await requireAnyPermission(SETTINGS_PERMISSIONS);

  const counts = await configurationCounts();
  const statuses = readiness(counts);

  const sections = sectionsFor(agent).map((section) => ({
    title: section.title,
    description: section.description,
    entries: section.pages.map((page) => ({
      href: page.href,
      label: page.label,
      description: page.description,
      keywords: page.keywords,
      status: statuses[page.href],
    })),
  }));

  // Only what this agent could go and fix: a check on a page they cannot open
  // is somebody else's to act on.
  const todo = sections
    .flatMap((section) => section.entries)
    .filter((entry) => entry.status?.state === 'todo');

  return (
    <>
      <PageHeader
        title="Settings"
        description="How work reaches your team, what it promises the customer, and what the customer sees."
      />

      {todo.length > 0 ? (
        <Notice tone="warning" icon className="mb-6">
          <p className="font-medium">
            {todo.length === 1 ? 'One thing needs' : `${todo.length} things need`} setting up:
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {todo.map((entry) => (
              <li key={entry.href}>
                <Link href={entry.href} className="font-medium underline">
                  {entry.label}
                </Link>{' '}
                — {entry.status?.text}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <SettingsDirectory sections={sections} />
    </>
  );
}

/**
 * What each page's card says about its own configuration, keyed by the page.
 * `optional` is for a page whose absence is a choice a team can make; `info`
 * is a plain fact with no verdict on it.
 */
function readiness(
  counts: Awaited<ReturnType<typeof configurationCounts>> | undefined,
): Record<string, DirectoryStatus> {
  const n = (value: number | undefined) => value ?? 0;
  const policies = n(counts?.policies);
  const routingGroups = n(counts?.routingGroups);
  const orphanSkills = n(counts?.orphanSkills);

  const statuses: Record<string, DirectoryStatus> = {
    '/admin/agents': { state: 'info', text: `${n(counts?.agents)} active` },
    '/admin/sla':
      policies > 0 && n(counts?.defaultPolicy) > 0
        ? { state: 'ready', text: `${policies} active, with a default` }
        : {
            state: 'todo',
            text:
              policies === 0
                ? 'None — no ticket has a due date, and the breach sweep has nothing to find'
                : 'No default policy — a ticket matching nothing gets no targets at all',
          },
    '/admin/groups':
      routingGroups > 0
        ? {
            state: 'ready',
            text: `${routingGroups} of ${n(counts?.allGroups)} group(s) assign automatically`,
          }
        : {
            state: 'optional',
            text: 'Every group is on manual — tickets wait in the queue until somebody picks them up',
          },
    '/admin/hours':
      n(counts?.schedules) > 0
        ? { state: 'ready', text: `${n(counts?.schedules)} schedule(s)` }
        : {
            state: 'todo',
            text: 'None — SLA targets and response times are counted through the night',
          },
    '/admin/channels':
      n(counts?.channels) > 0
        ? { state: 'ready', text: `${n(counts?.channels)} active` }
        : {
            state: 'todo',
            text: 'None configured — tickets still arrive, but with no default group',
          },
    // No number of locations is expected, so the only absence worth naming is
    // an empty register: the side-conversation picker then offers no hub, and
    // an agent types the address from memory. Optional because nothing routes
    // on a location.
    '/admin/locations':
      n(counts?.locations) > 0
        ? { state: 'ready', text: `${n(counts?.locations)} entered` }
        : { state: 'optional', text: 'None entered — the side-conversation picker offers no hub' },
    '/admin/automations':
      n(counts?.rules) > 0
        ? { state: 'ready', text: `${n(counts?.rules)} active rule(s)` }
        : { state: 'optional', text: 'None — every ticket is triaged by hand' },
    '/admin/canned':
      n(counts?.canned) > 0
        ? { state: 'ready', text: `${n(counts?.canned)} saved` }
        : {
            state: 'optional',
            text: 'None — automations have nothing to send as an acknowledgement',
          },
    '/admin/statuses': { state: 'info', text: `${n(counts?.statuses)} statuses` },
  };

  // Its own card now, where it used to turn the Groups check red and link to a
  // page that could not fix it: skills are held and granted on the Skills page.
  if (orphanSkills > 0) {
    statuses['/admin/skills'] = {
      state: 'todo',
      text: `${orphanSkills} skill(s) no active agent holds — tickets needing one wait for the skill timeout`,
    };
  }

  return statuses;
}
