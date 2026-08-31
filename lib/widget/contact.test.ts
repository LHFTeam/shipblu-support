import { describe, expect, it } from 'vitest';
import { parseVisitorDetails } from './contact';

/**
 * The rule under test is "one way back is enough". Out of hours this form is the
 * difference between a message the team can answer and one they cannot, so the
 * failure that matters is rejecting somebody who gave us something usable.
 */
describe('parseVisitorDetails', () => {
  it('accepts an email alone', () => {
    expect(parseVisitorDetails({ email: 'Nour@Example.com' })).toEqual({
      name: null,
      email: 'nour@example.com',
      phone: null,
    });
  });

  it('accepts a phone alone', () => {
    expect(parseVisitorDetails({ phone: '01001234567' })).toEqual({
      name: null,
      email: null,
      phone: '01001234567',
    });
  });

  it('normalises a phone the way an inbound WhatsApp webhook would carry it', () => {
    // So the value stored against the contact is comparable with what Meta
    // sends, rather than however the visitor happened to punctuate it.
    expect(parseVisitorDetails({ phone: '+20 100 123 4567' })?.phone).toBe('201001234567');
  });

  it('rejects a name with no way to reply to it', () => {
    expect(parseVisitorDetails({ name: 'Nour' })).toBeNull();
  });

  it('rejects an empty submission', () => {
    expect(parseVisitorDetails({})).toBeNull();
  });

  it('keeps the half that is usable when the other half is not', () => {
    expect(parseVisitorDetails({ email: 'not an address', phone: '01001234567' })).toEqual({
      name: null,
      email: null,
      phone: '01001234567',
    });
  });

  it.each([
    ['12345', 'too short to call'],
    ['1234567890123456', 'longer than E.164 allows'],
  ])('rejects %s — %s', (phone) => {
    expect(parseVisitorDetails({ phone })).toBeNull();
  });

  it('trims a name and drops an empty one', () => {
    expect(parseVisitorDetails({ name: '  ', email: 'nour@example.com' })?.name).toBeNull();
  });
});
