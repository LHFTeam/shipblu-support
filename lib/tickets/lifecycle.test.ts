import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `afterMessageStored` on a failure: every step is handed the customer's words,
 * and drizzle words a failed query with its parameters, so each step's line
 * carries the failure scrubbed, never whole — on every channel, not only the
 * myBlu app's (AGENTS.md, _The delivery platform_).
 */

const failures = vi.hoisted(() => ({ next: null as Error | null }));

vi.mock('@/lib/shipments/links', () => ({
  linkShipmentsFromMessage: () => {
    const failure = failures.next;
    return failure ? Promise.reject(failure) : Promise.resolve();
  },
}));
vi.mock('@/lib/subcategorise/apply', () => ({ subcategoriseFromMessage: () => Promise.resolve() }));
vi.mock('@/lib/priority-ai/enqueue', () => ({
  enqueuePriorityClassification: () => Promise.resolve(),
}));
vi.mock('@/lib/category-ai/enqueue', () => ({
  enqueueCategoryClassification: () => Promise.resolve(),
}));
vi.mock('@/lib/tickets/classifier-ticket', () => ({ classifierTicket: () => () => null }));
vi.mock('@/lib/assignment', () => ({ assignConversation: () => Promise.resolve() }));
vi.mock('@/lib/auto-response', () => ({ maybeSendAutoResponse: () => Promise.resolve() }));
vi.mock('@/lib/automations', () => ({ runAutomations: () => Promise.resolve(0) }));
vi.mock('@/lib/csat', () => ({ scheduleSurvey: () => Promise.resolve() }));
vi.mock('@/lib/routing/begin', () => ({ beginRouting: () => Promise.resolve('continue') }));
vi.mock('@/lib/sla', () => ({
  applySlaOnCreate: () => Promise.resolve(),
  onCustomerReply: () => Promise.resolve(),
}));

const { afterMessageStored } = await import('./lifecycle');

afterEach(() => {
  failures.next = null;
  vi.restoreAllMocks();
});

describe('afterMessageStored', () => {
  it('logs a failed shipment link without the tracking number the customer typed', async () => {
    const number = '1755021358719';
    failures.next = new Error(
      `Failed query: select 1 from "shipments" where "tracking_number" = $1\nparams: ${number}`,
      {
        cause: Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014',
          detail: `Key (tracking_number)=(${number}) is held.`,
        }),
      },
    );
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((part) => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part)))
          .join(' '),
      );
    });

    await afterMessageStored({
      conversationId: '00000000-0000-4000-8000-000000000001',
      messageId: '00000000-0000-4000-8000-000000000002',
      bodyText: `Where is ${number}?`,
      kind: 'reply',
      direction: 'inbound',
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('shipment linking failed');
    expect(logged[0]).toContain('57014');
    expect(logged[0]).not.toContain(number);
  });
});
