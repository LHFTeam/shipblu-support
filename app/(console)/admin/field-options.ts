import {
  listActiveAgents,
  listActiveTicketFields,
  listFormNames,
  listGroupNames,
} from '@/lib/admin/settings';
import { formName } from '@/lib/forms/naming';
import { PRIORITY_CHOICES } from '@/lib/tickets/vocabulary';
import type { FieldOption } from './condition-builder';

/**
 * The vocabulary the condition builder offers.
 *
 * Built from `lib/rules/facts` plus whatever custom fields exist, so the list
 * an admin picks from is exactly the list the engine can evaluate. Anything
 * else would let someone write a condition against a field that is always
 * absent, which silently never matches.
 *
 * A page that reads the agents or the groups for itself hands over the same
 * promise rather than having them read twice: every page that builds
 * conditions lists the agents, and the automations page the groups as well.
 * A promise rather than the list, so the read still runs beside the page's
 * others instead of after them.
 */
export async function ticketFieldOptions(
  given: {
    agents?: ReturnType<typeof listActiveAgents>;
    groups?: ReturnType<typeof listGroupNames>;
  } = {},
): Promise<FieldOption[]> {
  const [custom, forms, groupNames, agentNames] = await Promise.all([
    listActiveTicketFields(),
    listFormNames(),
    given.groups ?? listGroupNames(),
    given.agents ?? listActiveAgents(),
  ]);

  const base: FieldOption[] = [
    {
      value: 'priority',
      label: 'Priority',
      kind: 'choice',
      choices: PRIORITY_CHOICES,
    },
    {
      value: 'channel',
      label: 'Channel',
      kind: 'choice',
      choices: [
        { value: 'email', label: 'Email' },
        { value: 'whatsapp', label: 'WhatsApp' },
        { value: 'webchat', label: 'Web chat' },
        { value: 'facebook', label: 'Facebook' },
        { value: 'instagram', label: 'Instagram' },
      ],
    },
    {
      value: 'status.category',
      label: 'Status category',
      kind: 'choice',
      choices: [
        { value: 'open', label: 'Open' },
        { value: 'pending', label: 'Pending' },
        { value: 'resolved', label: 'Resolved' },
        { value: 'closed', label: 'Closed' },
      ],
    },
    { value: 'subject', label: 'Subject', kind: 'text' },
    { value: 'tags', label: 'Tags', kind: 'text' },
    { value: 'type', label: 'Type', kind: 'text' },
    { value: 'requester.email', label: 'Requester email', kind: 'text' },
    // A choice rather than free text, and the slug rather than the id: a rule
    // reading `form.slug is damaged-parcel` says what it routes on, and picking
    // from the forms that exist is what stops a rule being written against a
    // slug that was renamed and silently never matching again.
    {
      value: 'form.slug',
      label: 'Submitted through form',
      kind: 'choice',
      choices: forms.map((form) => ({
        value: form.slug,
        label: formName(form, 'en'),
      })),
    },
    // Choices, because the facts hold uuids (`lib/rules/facts.ts`) and nobody
    // types one. Offered as free text, production's SLA policies were written
    // against group *names* — "Merchant Care" — which never equal a uuid, so
    // every group condition in them was silently false. A stored name now
    // shows as "Unknown: Merchant Care" (`shownChoices`) so it can be replaced.
    {
      value: 'group.id',
      label: 'Group',
      kind: 'choice',
      choices: groupNames.map((group) => ({ value: group.id, label: group.name })),
    },
    {
      value: 'assignee.id',
      label: 'Assignee',
      kind: 'choice',
      choices: agentNames.map((agent) => ({ value: agent.id, label: agent.name })),
    },
    {
      value: 'is_assigned',
      label: 'Is assigned',
      kind: 'choice',
      choices: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    },
    { value: 'reopen_count', label: 'Times reopened', kind: 'number' },
    { value: 'hours_since_created', label: 'Hours since created', kind: 'number' },
    { value: 'hours_since_assigned', label: 'Hours since assigned', kind: 'number' },
    { value: 'hours_since_last_message', label: 'Hours since last message', kind: 'number' },
    {
      value: 'hours_since_last_customer_message',
      label: 'Hours since the customer wrote',
      kind: 'number',
    },
    {
      value: 'hours_since_last_agent_message',
      label: 'Hours since an agent wrote',
      kind: 'number',
    },
    { value: 'hours_since_resolved', label: 'Hours since resolved', kind: 'number' },
    {
      value: 'is_first_response_overdue',
      label: 'First response overdue',
      kind: 'choice',
      choices: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    },
    {
      value: 'is_resolution_overdue',
      label: 'Resolution overdue',
      kind: 'choice',
      choices: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    },
  ];

  const customOptions: FieldOption[] = custom.map((field) => ({
    value: `custom.${field.key}`,
    label: field.label,
    kind:
      field.type === 'number' || field.type === 'decimal'
        ? 'number'
        : field.options.length > 0
          ? 'choice'
          : 'text',
    choices: field.options.length ? field.options : undefined,
  }));

  return [...base, ...customOptions];
}
