import type { ticketShipments } from '@/lib/extension/tickets';
import type { TrackingView } from '@/lib/shipments/tracking-view';
import type { AgentTracking } from '@/lib/shipments/detail';
import type { PickerEntry, SideConversationView } from '@/lib/side-conversations/queries';
import type { ChatState } from '../messages';

/**
 * The console's `/api/extension/*` routes, called from the side panel.
 *
 * The panel is an extension page, so these calls carry the extension's origin
 * and pass by its host permission; the routes send no CORS headers, and no web
 * page can make them. The token lives in this origin's `localStorage`, which a
 * content script — running in web.whatsapp.com's origin — cannot read, and
 * which outlasts a browser restart as a week-long session has to.
 *
 * Response types are the server's own, imported as types only, so a field the
 * route stops sending fails `tsc` here instead of rendering blank.
 */

/** What JSON makes of a server type: every `Date` arrives as its ISO string. */
export type Wire<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export type Shipment = Wire<NonNullable<Awaited<ReturnType<typeof ticketShipments>>>[number]>;
export type Tracking = Wire<{ tracking: AgentTracking; view: TrackingView }>;
export type SideConversation = Wire<SideConversationView>;
export type Recipient = PickerEntry;

/**
 * What `POST /api/extension/resolve` answers for the chat on screen — stage 2,
 * which waits on the measurement in `plans/whatsapp-web-extension.md`. Until it
 * ships the route answers 404, and the panel says matching is not live yet.
 */
export type ResolvedTicket =
  | {
      visible: true;
      id: string;
      number: number;
      subject: string | null;
      requesterName: string | null;
    }
  /** A ticket the agent cannot see yet: enough for "Take this ticket", and no more. */
  | { visible: false; id: string; assigneeName: string | null };

const TOKEN_KEY = 'shipblu-support.token';

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // A profile that refuses storage signs in for this panel only.
  }
}

/** A refusal with the server's own sentence, which the panel shows as it is. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The session ended — expired, signed out elsewhere, or the agent deactivated. */
export class SignedOut extends ApiError {
  constructor() {
    super('Your session has ended. Sign in again.', 401);
  }
}

export function consoleUrl(path: string): string {
  return `${__SUPPORT_ORIGIN__}${path}`;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = readToken();
  let response: Response;
  try {
    response = await fetch(consoleUrl(`/api/extension${path}`), {
      method: init.method ?? 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // The console's cookie is never wanted here, and sending it would let a
      // console session stand in for a missing extension one.
      credentials: 'omit',
    });
  } catch {
    throw new ApiError('Could not reach ShipBlu Support. Check the connection.', 0);
  }

  if (response.status === 401 && path !== '/session') {
    writeToken(null);
    throw new SignedOut();
  }

  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof body === 'object' && body && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `ShipBlu Support answered ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export async function signIn(email: string, password: string): Promise<void> {
  const { token } = await call<{ token: string }>('/session', {
    method: 'POST',
    body: { email, password },
  });
  writeToken(token);
}

export async function signOut(): Promise<void> {
  try {
    await call<null>('/session', { method: 'DELETE' });
  } finally {
    writeToken(null);
  }
}

export function whoAmI() {
  return call<{ agent: { id: string; name: string; email: string } }>('/session');
}

/** Null when no ticket holds any of the chat's messages. */
export async function resolveChat(state: ChatState): Promise<ResolvedTicket | null> {
  const { ticket } = await call<{ ticket: ResolvedTicket | null }>('/resolve', {
    method: 'POST',
    body: { me: state.me, keys: state.keys ?? [] },
  });
  return ticket;
}

export function claimTicket(ticketId: string) {
  return call<{ ok: true }>(`/tickets/${ticketId}/claim`, { method: 'POST' });
}

export async function listShipments(ticketId: string): Promise<Shipment[]> {
  return (await call<{ shipments: Shipment[] }>(`/tickets/${ticketId}/shipments`)).shipments;
}

export function shipmentTracking(ticketId: string, shipmentId: string): Promise<Tracking> {
  return call<Tracking>(`/tickets/${ticketId}/shipments/${shipmentId}`);
}

export function listSideConversations(ticketId: string) {
  return call<{ canWrite: boolean; sideConversations: SideConversation[] }>(
    `/tickets/${ticketId}/side-conversations`,
  );
}

export async function listRecipients(): Promise<Recipient[]> {
  return (await call<{ recipients: Recipient[] }>('/side-conversation-recipients')).recipients;
}

export function startSideConversation(
  ticketId: string,
  draft: {
    recipientId: string;
    toAddress: string;
    ccAddresses: string;
    subject: string;
    body: string;
    setPending: boolean;
  },
) {
  return call<{ ok: true }>(`/tickets/${ticketId}/side-conversations`, {
    method: 'POST',
    body: draft,
  });
}

export function replyToSideConversation(sideConversationId: string, body: string) {
  return call<{ ok: true }>(`/side-conversations/${sideConversationId}/replies`, {
    method: 'POST',
    body: { body },
  });
}

export function setSideConversationState(sideConversationId: string, state: 'open' | 'done') {
  return call<{ ok: true }>(`/side-conversations/${sideConversationId}/state`, {
    method: 'POST',
    body: { state },
  });
}
