import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketFields, ticketStatuses } from '@/db/schema';
import type { FieldOption } from './condition-builder';

/**
 * The vocabulary the condition builder offers.
 *
 * Built from `lib/rules/facts` plus whatever custom fields exist, so the list
 * an admin picks from is exactly the list the engine can evaluate. Anything
 * else would let someone write a condition against a field that is always
 * absent, which silently never matches.
 */
export async function ticketFieldOptions(): Promise<FieldOption[]> {
  const [custom, statuses] = await Promise.all([
    db
      .select()
      .from(ticketFields)
      .where(eq(ticketFields.isActive, true))
      .orderBy(asc(ticketFields.position)),
    db
      .select({ name: ticketStatuses.name, category: ticketStatuses.category })
      .from(ticketStatuses),
  ]);

  void statuses;

  const base: FieldOption[] = [
    {
      value: 'priority',
      label: 'Priority',
      kind: 'choice',
      choices: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'urgent', label: 'Urgent' },
      ],
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
    { value: 'group.id', label: 'Group', kind: 'text' },
    { value: 'assignee.id', label: 'Assignee', kind: 'text' },
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
