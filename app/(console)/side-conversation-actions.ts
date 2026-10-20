'use server';

import { requireAgent } from '@/lib/auth/guard';
import { text } from '@/lib/http/form-data';
import { ok } from '@/lib/http/action-state';
import * as side from '@/lib/side-conversations/write';
import { refresh } from '@/lib/tickets/console-guards';
import type { ActionState } from './action-state';

// --- Side conversations -----------------------------------------------------

/**
 * The thread an agent opens with a hub, a warehouse or a vendor.
 *
 * The writes themselves live in `lib/side-conversations/write.ts`, shared with
 * the WhatsApp Web extension's routes, so the permission, the ticket's
 * visibility rule and the refusal of the customer's own address are checked by
 * one copy whichever surface the agent used. What is left here is reading the
 * form and refreshing the ticket.
 */

export async function startSideConversation(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();

  const result = await side.startSideConversation(agent, {
    conversationId: String(formData.get('conversationId') ?? ''),
    body: text(formData, 'body'),
    recipientId: String(formData.get('recipientId') ?? ''),
    toAddress: String(formData.get('toAddress') ?? ''),
    ccAddresses: String(formData.get('ccAddresses') ?? ''),
    subject: text(formData, 'subject'),
    anchorMessageId: String(formData.get('anchorMessageId') ?? '') || null,
    includeAnchor: formData.get('includeAnchor') === 'on',
    setPending: formData.get('setPending') === 'on',
  });
  if (result.error !== null) return { error: result.error };

  refresh(result.conversationNumber);
  return ok();
}

export async function replyToSideConversation(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();

  const result = await side.replyToSideConversation(agent, {
    sideConversationId: String(formData.get('sideConversationId') ?? ''),
    body: text(formData, 'body'),
  });
  if (result.error !== null) return { error: result.error };

  refresh(result.conversationNumber);
  return ok();
}

/** Mark a thread done, or reopen one. */
export async function setSideConversationState(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();

  const result = await side.setSideConversationState(agent, {
    sideConversationId: String(formData.get('sideConversationId') ?? ''),
    state: String(formData.get('state') ?? ''),
  });
  if (result.error !== null) return { error: result.error };

  refresh(result.conversationNumber);
  return ok();
}
