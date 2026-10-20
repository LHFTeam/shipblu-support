import { describe, expect, it } from 'vitest';
import type { AgentTracking } from './detail';
import { trackingView } from './tracking-view';

function tracking(values: Partial<AgentTracking>): AgentTracking {
  return {
    trackingNumber: '1234567890123',
    status: 'in_transit',
    statusAt: null,
    events: [],
    estimatedDate: null,
    rtoRequested: false,
    platformId: null,
    bookedEstimatedDate: null,
    merchantName: null,
    merchantPhone: null,
    recipientName: null,
    recipientPhone: null,
    recipientEmail: null,
    addressLines: [],
    zone: null,
    city: null,
    governorate: null,
    codAmount: null,
    preferredDate: null,
    deliveredAt: null,
    pickedUpAt: null,
    ...values,
  };
}

const at = (iso: string) => new Date(iso);

describe('trackingView', () => {
  it('reads an outbound parcel by its status, history newest first', () => {
    const view = trackingView(
      tracking({
        status: 'out_for_delivery',
        events: [
          { status: 'picked_up', at: at('2026-10-01T08:00:00Z'), comment: null },
          { status: 'out_for_delivery', at: at('2026-10-02T08:00:00Z'), comment: null },
        ],
      }),
    );

    expect(view.returning).toBeNull();
    expect(view.statusLabel).toBe('Out for delivery');
    expect(view.platformSays).toBeNull();
    expect(view.events.map((event) => [event.label, event.onReturnLeg])).toEqual([
      ['Out for delivery', false],
      ['Picked up', false],
    ]);
  });

  it('reads a return by its step, not the status the platform leaves behind (§6.40)', () => {
    const view = trackingView(
      tracking({
        status: 'delivery_attempted',
        rtoRequested: true,
        events: [
          { status: 'in_transit', at: at('2026-10-01T08:00:00Z'), comment: null },
          { status: 'delivery_attempted', at: at('2026-10-02T08:00:00Z'), comment: null },
          { status: 'return_to_origin', at: at('2026-10-03T08:00:00Z'), comment: null },
          { status: 'in_transit', at: at('2026-10-04T08:00:00Z'), comment: null },
        ],
      }),
    );

    expect(view.returning).not.toBeNull();
    expect(view.statusLabel).not.toBe('Delivery attempted');
    expect(view.platformSays).toBe('Delivery attempted');
    // The same `in_transit` on both legs, told apart.
    expect(view.events.map((event) => [event.label, event.onReturnLeg])).toEqual([
      ['In transit', true],
      ['Return to origin', true],
      ['Delivery attempted', false],
      ['In transit', false],
    ]);
  });
});
