import { listTicketFields } from '@/lib/tickets/lookups';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';

/**
 * The custom fields a customer may fill in when opening a ticket.
 *
 * Both flags, not either: `visible_to_customer` decides whether they may read
 * it, `editable_by_customer` whether they may write it. A field that is one but
 * not the other has no input on this form — a read-only field has nothing to
 * show on a ticket that does not exist yet, and a writable-but-hidden field is a
 * contradiction the admin form should not have allowed.
 *
 * The filter is why `required_on_create` is checked against *this* list rather
 * than every active field. An admin can mark an internal-only field required —
 * "Root cause", say — and a customer has no way to answer it; enforcing that on
 * the portal would refuse every ticket anybody tried to open, with a message
 * pointing at a field they cannot see. Required on create means required of
 * whoever is filling the form in, and on the portal that is the customer.
 */
export async function customerTicketFields(): Promise<TicketFieldDef[]> {
  const fields = await listTicketFields();
  return fields.filter((field) => field.visibleToCustomer && field.editableByCustomer);
}
