import { describe, expect, it } from 'vitest';
import { parseAddressList, refuseRecipient, refuseRecipients } from './guard';

const CONTEXT = {
  ourAddresses: ['support@shipblu.com'],
  requesterAddresses: ['nadia@example.com', 'nadia.work@example.org'],
};

describe('refuseRecipient', () => {
  it('accepts an internal hub address', () => {
    expect(refuseRecipient('hub-downtown@shipblu.com', CONTEXT)).toBeNull();
  });

  it('accepts regardless of case and surrounding space', () => {
    expect(refuseRecipient('  Hub-Downtown@ShipBlu.com ', CONTEXT)).toBeNull();
  });

  /**
   * The refusal the whole feature exists to have. An agent who pastes the
   * address out of the ticket header sends the internal question to the person
   * it is about, and there is no undo.
   */
  it('refuses the ticket requester', () => {
    expect(refuseRecipient('nadia@example.com', CONTEXT)).toMatch(/customer/i);
  });

  it('refuses any other address the requester is known by', () => {
    // Not only the address on the ticket: contact_identities can hold several,
    // and reaching the customer on their second one is the same leak.
    expect(refuseRecipient('NADIA.WORK@example.org', CONTEXT)).toMatch(/customer/i);
  });

  it('refuses our own address', () => {
    expect(refuseRecipient('support@shipblu.com', CONTEXT)).toMatch(/own address/i);
  });

  it('refuses our own address wearing a reply token', () => {
    // What our outbound Reply-To actually looks like, so this is the shape an
    // agent is most likely to paste back in.
    expect(refuseRecipient('support+s4.deadbeefdeadbeef@shipblu.com', CONTEXT)).toMatch(
      /own address/i,
    );
  });

  it('refuses blanks and things that are not addresses', () => {
    expect(refuseRecipient('', CONTEXT)).toMatch(/choose a recipient/i);
    expect(refuseRecipient('   ', CONTEXT)).toMatch(/choose a recipient/i);
    expect(refuseRecipient('Downtown Hub', CONTEXT)).toMatch(/not an email address/i);
    expect(refuseRecipient('hub-downtown', CONTEXT)).toMatch(/not an email address/i);
    expect(refuseRecipient('hub@localhost', CONTEXT)).toMatch(/not an email address/i);
  });
});

describe('refuseRecipients', () => {
  it('passes a clean list', () => {
    expect(refuseRecipients(['hub@shipblu.com', 'ops@shipblu.com'], CONTEXT)).toBeNull();
  });

  it('refuses the list when any one entry is the customer', () => {
    // A CC is exactly as delivered as a To.
    expect(refuseRecipients(['hub@shipblu.com', 'nadia@example.com'], CONTEXT)).toMatch(
      /customer/i,
    );
  });
});

describe('parseAddressList', () => {
  it('splits on commas and semicolons, trims, lowercases and dedupes', () => {
    expect(parseAddressList('A@x.com, b@x.com; A@X.com , ')).toEqual(['a@x.com', 'b@x.com']);
  });

  it('returns nothing for an empty field', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('  ,  ; ')).toEqual([]);
  });
});
