import { describe, expect, it } from 'vitest';
import { shipmentCard } from './card';

const base = {
  returnStep: null,
  syncState: 'synced' as const,
  statusLabel: 'in_transit',
  currentEstimatedDate: null,
};

describe('shipmentCard', () => {
  it('lets a return outrank the delivery_attempted label it hides behind (§6.40)', () => {
    const card = shipmentCard({
      ...base,
      statusLabel: 'delivery_attempted',
      returnStep: 1,
      currentEstimatedDate: '2026-10-14',
    });

    expect(card.label).toBe('On the way');
    expect(card.tone).toBe('returned');
    expect(card.bar).toEqual({
      tone: 'returning',
      step: 1,
      labels: ['Returning to sender', 'On the way', 'Out for return', 'Returned'],
    });
    expect(card.due).toBeNull();
  });

  it('draws a synced parcel on the outbound bar with the platform word', () => {
    const card = shipmentCard({ ...base, currentEstimatedDate: '2026-10-14' });

    expect(card.label).toBe('In transit');
    expect(card.tone).toBe('in-transit');
    expect(card.bar).toEqual({
      tone: 'brand',
      step: 1,
      labels: ['Picked up', 'In transit', 'Out for delivery', 'Delivered'],
    });
    expect(card.due).toBe('2026-10-14');
  });

  it('has no due date once delivered', () => {
    const card = shipmentCard({
      ...base,
      statusLabel: 'delivered',
      currentEstimatedDate: '2026-10-14',
    });

    expect(card.tone).toBe('delivered');
    expect(card.bar?.step).toBe(3);
    expect(card.due).toBeNull();
  });

  it('says a stub and an unknown number are not statuses, with no bar', () => {
    const stub = shipmentCard({ ...base, syncState: 'stub', statusLabel: null });
    expect(stub).toMatchObject({ label: 'Not synced yet', tone: 'unknown', bar: null });

    const missing = shipmentCard({ ...base, syncState: 'not_found', statusLabel: null });
    expect(missing).toMatchObject({
      label: 'Not a shipment on the platform',
      tone: 'unknown',
      bar: null,
    });

    const empty = shipmentCard({ ...base, statusLabel: null });
    expect(empty).toMatchObject({ label: 'No status yet', tone: 'unknown', bar: null });
  });

  it('draws an unrecognised label as words alone, off the bar', () => {
    const card = shipmentCard({ ...base, statusLabel: 'teleported' });

    expect(card).toMatchObject({ label: 'Teleported', tone: 'unknown', bar: null });
  });

  it('puts a created parcel on the first step without borrowing a tone', () => {
    const card = shipmentCard({ ...base, statusLabel: 'created' });

    expect(card.tone).toBe('unknown');
    expect(card.bar?.step).toBe(0);
  });

  it('keeps the estimate on a parcel that is not synced, as the sidebar always has', () => {
    const card = shipmentCard({
      ...base,
      syncState: 'stub',
      statusLabel: null,
      currentEstimatedDate: '2026-10-14',
    });

    expect(card.due).toBe('2026-10-14');
  });
});
