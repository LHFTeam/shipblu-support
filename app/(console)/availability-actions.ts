'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { requestAssignmentSweep, setAccepting } from '@/lib/assignment/presence';
import { requireAgent, requirePermission } from '@/lib/auth/guard';

export type AvailabilityState = { error: string | null; accepting?: boolean };

/**
 * The agent's own availability switch.
 *
 * Needs no permission beyond being signed in: it is a statement about
 * themselves, and the only thing it can do is send fewer tickets their way.
 *
 * Turning it back on asks the sweep to look at the queue, so somebody coming out
 * of a meeting picks up what is waiting rather than waiting for the next
 * five-minute tick.
 */
export async function setAcceptingTickets(
  _state: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const agent = await requireAgent();
  const accepting = formData.get('accepting') === 'true';

  // Through the presence module rather than writing the column here: the switch
  // marks the boundary between available and merely present, and that boundary
  // has to land in the presence history or "available time" in the productivity
  // report counts an agent who spent the afternoon in a meeting as working it.
  //
  // `self` is what stops the idle machinery undoing this. An agent who turns
  // themselves off before a meeting keeps the tab open and keeps moving the
  // mouse; if this were recorded as idleness, the first keypress would put them
  // back in the rota (see `availabilityReasonEnum`).
  await setAccepting(agent.id, accepting, 'self');

  if (accepting) await requestAssignmentSweep();

  revalidatePath('/inbox');
  return { error: null, accepting };
}

/**
 * Somebody else's availability, set by a supervisor or an admin.
 *
 * The queue-covering counterpart to the switch above: an agent who has walked
 * away with tickets routing to them, or one whose switch is still off an hour
 * after the meeting ended while the queue backs up.
 *
 * Recorded as `supervisor`, which is what makes it survive the agent returning
 * to their keyboard — an automatic away is undone by input, a decision is not.
 * It is not a lock: the agent's own switch still works, and an agent who
 * disagrees can turn it back. That is deliberate, and the alternative is worse
 * — an agent silently unable to take work with nothing on screen to say why.
 *
 * The id arrives in a form field, so the row is re-read here rather than
 * trusted: the target has to be a real, active agent before anything is
 * written.
 */
export async function setAgentAvailability(
  _state: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  await requirePermission('agent.availability');

  const accepting = formData.get('accepting') === 'true';

  // Shape-checked before it reaches the query. A uuid column compared against
  // "banana" is a Postgres error (22P02), not an empty result, so without this
  // a mistyped id is a 500 rather than "no such agent".
  const agentId = z.uuid().safeParse(formData.get('agentId'));
  if (!agentId.success) return { error: 'That agent could not be found.' };

  const rows = await db
    .select({ id: agents.id, name: agents.name, isActive: agents.isActive })
    .from(agents)
    .where(eq(agents.id, agentId.data))
    .limit(1);

  const target = rows[0];
  if (!target) return { error: 'That agent could not be found.' };

  // A deactivated agent is already excluded from every queue. Writing an
  // availability onto them would leave a value nobody can see or undo, because
  // they never appear on this page again.
  if (!target.isActive) return { error: `${target.name} is deactivated.` };

  await setAccepting(target.id, accepting, 'supervisor');

  if (accepting) await requestAssignmentSweep();

  revalidatePath('/reports/team');
  return { error: null, accepting };
}
