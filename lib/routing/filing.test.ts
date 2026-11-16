import { describe, expect, it } from 'vitest';
import {
  filesRoutableTickets,
  filingGap,
  filingRowFor,
  ownedByActiveAgent,
  type FilingInput,
} from './filing';

type Row = FilingInput & { name: string };

const row = (name: string, values: Partial<Row> = {}): Row => ({
  name,
  type: 'webchat',
  isActive: true,
  ownerActive: null,
  ...values,
});

describe('which row a channel’s tickets are filed under', () => {
  it('files a kind under its oldest active row, so a second row files nothing', () => {
    const retired = row('Retired', { isActive: false });
    const first = row('First');
    const second = row('Second');
    const rows = [retired, first, second];

    expect(filingRowFor(second, rows)).toBe(first);
    expect(filesRoutableTickets(first, rows)).toBe(true);
    expect(filesRoutableTickets(second, rows)).toBe(false);
    expect(filesRoutableTickets(retired, rows)).toBe(false);
  });

  it('takes a WhatsApp number as its own row, whatever else is of its kind', () => {
    const older = row('Older', { type: 'whatsapp' });
    const number = row('Number', { type: 'whatsapp' });
    expect(filingRowFor(number, [older, number])).toBe(number);
    expect(filesRoutableTickets(number, [older, number])).toBe(true);
  });

  it('files nothing routable on a number an active owner holds, and routes again once they are deactivated', () => {
    const owned = row('Owned', { type: 'whatsapp', ownerActive: true });
    expect(ownedByActiveAgent(owned)).toBe(true);
    expect(filesRoutableTickets(owned, [owned])).toBe(false);

    const deactivated = { ...owned, ownerActive: false };
    expect(ownedByActiveAgent(deactivated)).toBe(false);
    expect(filesRoutableTickets(deactivated, [deactivated])).toBe(true);
  });

  // One reason per row, in one order, so the readiness panel and the routing
  // report name the same one. A type nothing files under yet is that reason
  // first: switched off or not, the first of its type or not, no ticket of its
  // has ever been held.
  it('names one reason a row files nothing routable, a type not filed yet first', () => {
    const first = row('First');
    const second = row('Second');
    const off = row('Off', { isActive: false });
    expect(filingGap(first, [first, second])).toBeNull();
    expect(filingGap(second, [first, second])).toBe('another_row');
    expect(filingGap(off, [off, first])).toBe('inactive');
    expect(filingGap(row('Owned', { type: 'whatsapp', ownerActive: true }), [])).toBe('owned');

    // The myBlu app files under its oldest active row, as web chat does.
    const app = row('App', { type: 'api' });
    const appOff = row('App off', { type: 'api', isActive: false });
    expect(filingGap(app, [app])).toBeNull();
    expect(filingGap(appOff, [appOff, app])).toBe('inactive');
  });
});
