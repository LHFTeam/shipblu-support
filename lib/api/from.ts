import type { z } from 'zod';
import type { MessageFrom } from './schemas';

/**
 * Who wrote a message, as the widget maps it, with `customer` for its
 * `visitor`: the user for an inbound row, a person on the team for an outbound
 * one an agent wrote, and nobody — the acknowledgement, a rule's reply — for
 * the rest.
 *
 * One function for the two places the app is told it: a message as the API
 * reads it (`lib/api/tickets.ts`) and the webhook's `message.from`
 * (`lib/api/webhook.ts`), so a push cannot call an answer `agent` that the
 * thread then draws as `system`.
 */
export function messageFrom(row: {
  direction: string;
  byAgent: boolean;
}): z.input<typeof MessageFrom> {
  if (row.direction === 'inbound') return 'customer';
  return row.byAgent ? 'agent' : 'system';
}
