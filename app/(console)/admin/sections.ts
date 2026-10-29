import { can, type Permission } from '@/lib/auth/permissions';

/**
 * The settings area's map: every page, which group it belongs to, and the key
 * that opens it. The sidebar, the phone strip, the settings home and its search
 * are all drawn from this one list, so a page cannot be in the nav and missing
 * from the home, or findable by search and hidden from the sidebar. A child
 * page has no card of its own: the home reaches it through its parent's card,
 * whose keywords name it.
 *
 * The groups follow what the helpdesks our team already knows agree on —
 * Zendesk's Admin Center, Freshdesk's Admin, Intercom's Settings — rather than
 * which table a setting is stored in, because "where do I change the SLA?" is a
 * question about what you want to happen:
 *
 *  - **Team**: who works here and how work is shared between them. Skills sit
 *    here, as in Zendesk and Freshdesk, because what a skill names is a person's
 *    ability; the matching is switched on per group.
 *  - **Channels**: where customers reach us, and the customer-facing pages that
 *    hang off them.
 *  - **Tickets**: what a ticket is made of — Zendesk's "Objects and rules ›
 *    Tickets", Freshdesk's ticket fields and forms.
 *  - **Workflows**: rules that act on tickets and the promises they keep, with
 *    the calendar those promises are counted in and the messages a customer is
 *    sent automatically — Freshdesk's Workflows, Zendesk's Business rules.
 *  - **Agent tools**: what an agent reaches for while working a ticket —
 *    Zendesk's Agent tools, Freshdesk's Agent productivity. The side
 *    conversation directory is here, because nothing routes on it.
 *  - **AI**: one place that says what the model does, whatever page each switch
 *    lives on. Every platform above now gives AI its own group.
 *  - **Data**: bringing data in, which every one of them files away from
 *    channels.
 *
 * URLs stay flat (`/admin/<page>`), as Freshdesk's and Help Scout's do: a
 * group is a heading, not a path segment, so regrouping a page never breaks a
 * bookmark, a revalidation or a sentence in the docs.
 *
 * `permission` is the key the page itself requires, and the `admin-sections`
 * repo rule holds the two to one answer: a link shown to somebody the page
 * refuses is a dead end, and a page hidden from somebody it admits is lost. An
 * array means any one of them opens the page. A page that is not here fails the
 * same rule, so a new screen has to be given a place in the map.
 */

export type AdminLink = {
  href: string;
  label: string;
  /** Held by the page's own `requirePermission` (or `requireAnyPermission`). */
  permission: Permission | readonly Permission[];
};

export type AdminPage = AdminLink & {
  /** One line, for the settings home and the search that reads it. */
  description: string;
  /**
   * The words other helpdesks use for the same thing, and the settings that
   * live on the page under a heading of their own — what somebody types into
   * the search when they do not know what we call it here.
   */
  keywords: readonly string[];
  /** Pages reached from this one, drawn under it in the sidebar. */
  children?: readonly AdminLink[];
};

export type AdminSection = {
  title: string;
  description: string;
  pages: readonly AdminPage[];
};

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    title: 'Team',
    description: 'Who works here, and how work is shared between them.',
    pages: [
      {
        href: '/admin/agents',
        label: 'Agents',
        permission: 'admin.agents',
        description:
          'Invite people, set their role and groups, and when idle agents stop getting work.',
        keywords: [
          'users',
          'teammates',
          'staff',
          'invite',
          'role',
          'permissions',
          'supervisor',
          'deactivate',
          'ticket cap',
          'capacity',
          'idle',
          'auto away',
          'sign out',
          'session timeout',
        ],
      },
      {
        href: '/admin/groups',
        label: 'Groups',
        permission: 'admin.groups',
        description:
          'The teams tickets are routed to, who is in each, and how each one hands its work out.',
        keywords: [
          'teams',
          'members',
          'assignment',
          'auto assign',
          'round robin',
          'load balanced',
          'load balancing',
          'routing',
          'reclaim',
          'escalation',
          'capacity',
        ],
      },
      {
        href: '/admin/skills',
        label: 'Skills',
        permission: 'admin.skills',
        description: 'What a ticket needs somebody to be able to do, and who on the team can.',
        keywords: ['skill based routing', 'language', 'tier', 'expertise', 'routing'],
      },
    ],
  },
  {
    title: 'Channels',
    description: 'Where customers reach you, and the pages they see.',
    pages: [
      {
        href: '/admin/channels',
        label: 'Channels',
        permission: 'admin.channels',
        description:
          'Email, WhatsApp, Facebook, Instagram and the chat widget: where each lands and how it routes.',
        keywords: [
          'email',
          'mailbox',
          'support address',
          'whatsapp',
          'waba',
          'business account',
          'message templates',
          'phone number',
          'coexistence',
          'embedded signup',
          'facebook',
          'messenger',
          'instagram',
          'comments',
          'widget',
          'web chat',
          'messenger widget',
          'routing by category',
          'number owner',
          'default group',
        ],
      },
      {
        href: '/admin/tracking',
        label: 'Tracking page wording',
        permission: 'admin.fields',
        description: 'What the help centre’s tracking page calls each delivery and return status.',
        keywords: [
          'help centre',
          'help center',
          'portal',
          'shipment',
          'delivery status',
          'courier reasons',
          'wording',
          'arabic',
        ],
      },
    ],
  },
  {
    title: 'Tickets',
    description: 'What a ticket is made of.',
    pages: [
      {
        href: '/admin/statuses',
        label: 'Statuses',
        permission: 'admin.fields',
        description:
          'What a ticket can be, which statuses pause the SLA clock, and what customers see.',
        keywords: ['ticket status', 'pending', 'on hold', 'resolved', 'closed', 'pause sla'],
      },
      {
        href: '/admin/fields',
        label: 'Fields',
        permission: 'admin.fields',
        description: 'Extra information recorded on a ticket, and what rules call each field.',
        keywords: ['ticket fields', 'custom fields', 'properties', 'dropdown', 'required'],
      },
      {
        href: '/admin/forms',
        label: 'Forms',
        permission: 'admin.forms',
        description:
          'The questions that open a ticket, on the help centre or the console, and where it lands.',
        keywords: [
          'ticket forms',
          'web form',
          'contact form',
          'help centre',
          'help center',
          'questions',
        ],
      },
      {
        href: '/admin/categories',
        label: 'Categories',
        permission: 'admin.categories',
        description:
          'Which team’s work a ticket is, the group each category routes to, and Jev’s classifier.',
        keywords: [
          'ticket type',
          'team',
          'route group',
          'routing by category',
          'routing window',
          'classifier',
          'jev',
          'triage',
        ],
      },
      {
        href: '/admin/subcategories',
        label: 'Subcategories',
        permission: 'admin.subcategories',
        description:
          'What tickets are about and why they happen, and the review of what rules found.',
        keywords: [
          'topics',
          'reasons',
          'root causes',
          'taxonomy',
          'tags',
          'contact reasons',
          'review queue',
          'shadow runs',
        ],
        children: [
          {
            href: '/admin/subcategories/review',
            label: 'Review queue',
            permission: 'admin.subcategories',
          },
          {
            href: '/admin/subcategories/shadow',
            label: 'Shadow runs',
            permission: 'admin.subcategories',
          },
        ],
      },
    ],
  },
  {
    title: 'Workflows',
    description: 'Rules that act on tickets, and the promises you keep to customers.',
    pages: [
      {
        href: '/admin/automations',
        label: 'Automations',
        permission: 'admin.automations',
        description:
          'Rules that act on a ticket when it is created, when it changes, or on a timer.',
        keywords: [
          'triggers',
          'rules',
          'workflows',
          'business rules',
          'on create',
          'on update',
          'time based',
          'auto close',
        ],
      },
      {
        href: '/admin/sla',
        label: 'SLA policies',
        permission: 'admin.sla',
        description:
          'Response and resolution targets, which tickets each applies to, and escalations.',
        keywords: [
          'service level',
          'targets',
          'first response',
          'resolution time',
          'due date',
          'breach',
          'escalation',
          'priority',
        ],
      },
      {
        href: '/admin/hours',
        label: 'Business hours',
        permission: 'admin.sla',
        description: 'The working hours and holidays SLA targets are counted in, per schedule.',
        keywords: [
          'office hours',
          'schedules',
          'working hours',
          'holidays',
          'calendar',
          'time zone',
          'timezone',
        ],
      },
      {
        href: '/admin/auto-responses',
        label: 'Out-of-hours replies',
        permission: 'admin.automations',
        description: 'What a customer is told when they write in while their group is closed.',
        keywords: [
          'auto reply',
          'autoresponder',
          'out of office',
          'after hours',
          'ooo',
          'away message',
          'closed',
          'holiday message',
          'acknowledgement',
        ],
      },
      {
        href: '/admin/csat',
        label: 'Satisfaction surveys',
        permission: 'admin.csat',
        description:
          'Asking customers to rate the support once a ticket is resolved, and its wording.',
        keywords: ['csat', 'customer satisfaction', 'feedback', 'rating', 'survey', 'nps'],
      },
    ],
  },
  {
    title: 'Agent tools',
    description: 'What agents reach for while they work a ticket.',
    pages: [
      {
        href: '/admin/canned',
        label: 'Canned responses',
        permission: 'admin.fields',
        description:
          'Reusable replies agents insert and automations send, and the reply box’s suggestion.',
        keywords: [
          'macros',
          'saved replies',
          'snippets',
          'templates',
          'quick replies',
          'shortcuts',
          'suggestions',
        ],
      },
      {
        href: '/admin/locations',
        label: 'Locations',
        permission: 'admin.locations',
        description: 'The hubs and warehouses an agent can start a side conversation with.',
        keywords: ['side conversations', 'hubs', 'warehouses', 'branches', 'directory'],
      },
      {
        href: '/admin/recipients',
        label: 'Internal recipients',
        permission: 'admin.channels',
        description: 'The teams and vendors an agent can start a side conversation with.',
        keywords: [
          'side conversations',
          'vendors',
          'couriers',
          'finance',
          'departments',
          'directory',
        ],
      },
    ],
  },
  {
    title: 'AI',
    description: 'What Jev does for the team, and where each part of it is switched.',
    pages: [
      {
        href: '/admin/ai',
        label: 'AI features',
        permission: ['admin.categories', 'admin.fields', 'admin.subcategories'],
        description:
          'Every place TypeSafe’s Jev model is asked a question: what it may change, and whether it is on.',
        keywords: [
          'jev',
          'typesafe',
          'artificial intelligence',
          'machine learning',
          'copilot',
          'classifier',
          'triage',
          'priority',
          'suggestions',
        ],
      },
    ],
  },
  {
    title: 'Data',
    description: 'Bringing data in from elsewhere, and filling in what came before.',
    pages: [
      {
        href: '/admin/import',
        label: 'Imports & backfills',
        permission: 'admin.agents',
        description:
          'The Freshdesk knowledge base import, and the backfills that link old tickets to shipments and places.',
        keywords: ['freshdesk', 'migration', 'import', 'backfill', 'shipments', 'knowledge base'],
      },
    ],
  },
];

function permitted(
  agent: Parameters<typeof can>[0],
  permission: Permission | readonly Permission[],
): boolean {
  return typeof permission === 'string'
    ? can(agent, permission)
    : permission.some((key) => can(agent, key));
}

/**
 * Every key that opens at least one settings page: holding any of them is what
 * lets somebody into the area at all. Derived rather than listed, so a page
 * added under a new key is reachable by whoever holds it.
 */
export const SETTINGS_PERMISSIONS: readonly Permission[] = [
  ...new Set(
    ADMIN_SECTIONS.flatMap((section) =>
      section.pages.flatMap((page) => [page, ...(page.children ?? [])]),
    ).flatMap((link) =>
      typeof link.permission === 'string' ? [link.permission] : link.permission,
    ),
  ),
];

/**
 * The map as this agent may use it: pages they cannot open are left out, and a
 * group left empty goes with them, the way the sidebar in every helpdesk above
 * hides what a role cannot reach. The page still checks its own key; this only
 * keeps the nav from offering a door that answers "forbidden".
 */
export function sectionsFor(agent: Parameters<typeof can>[0]): AdminSection[] {
  return ADMIN_SECTIONS.map((section) => ({
    ...section,
    pages: section.pages
      .filter((page) => permitted(agent, page.permission))
      .map((page) => ({
        ...page,
        children: page.children?.filter((child) => permitted(agent, child.permission)),
      })),
  })).filter((section) => section.pages.length > 0);
}

/**
 * The one link that is "here": the longest whose path the current one is or
 * sits under, compared by whole segment. Prefix matching alone lit
 * Subcategories and Review queue together on the review page, and
 * `/admin/sla` must not light up for a page at `/admin/slack`.
 */
export function currentHref(
  pathname: string,
  sections: readonly {
    links: readonly { href: string; children: readonly { href: string }[] }[];
  }[],
): string | null {
  if (pathname === '/admin') return '/admin';
  let best: string | null = null;
  for (const section of sections) {
    for (const link of section.links.flatMap((item) => [item, ...item.children])) {
      const inside = pathname === link.href || pathname.startsWith(`${link.href}/`);
      if (inside && (best === null || link.href.length > best.length)) best = link.href;
    }
  }
  return best;
}
