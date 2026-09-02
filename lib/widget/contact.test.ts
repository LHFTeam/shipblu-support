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

/**
 * The widget's own form judges the fields with this same function before it
 * shows an error, so these cases are the boundary the two sides share. A value
 * that passes here and fails there is the bug the sharing exists to prevent:
 * the visitor sees nothing happen and believes they left a number.
 */
describe('parseVisitorDetails as the form sees it', () => {
  it.each([
    ['0100', 'a half-typed phone'],
    ['nour', 'a half-typed email'],
    ['  ', 'whitespace'],
  ])('rejects %s (%s), which a non-empty check would accept', (value) => {
    expect(parseVisitorDetails({ email: value })).toBeNull();
    expect(parseVisitorDetails({ phone: value })).toBeNull();
  });

  it('accepts what the widget offers as a plausible Egyptian mobile', () => {
    expect(parseVisitorDetails({ name: 'Nour', phone: '010 0123 4567' })).toEqual({
      name: 'Nour',
      email: null,
      phone: '01001234567',
    });
  });
});
