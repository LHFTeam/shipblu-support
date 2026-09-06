import { describe, expect, it } from 'vitest';
import { takeThreadControlRequest, TAKE_CONTROL_METADATA } from './handover';

/*
  The only check there is on this shape.

  Nothing local can call Graph, and Graph does not describe a body it dislikes —
  it answers `100 "Unsupported post request…"`, which is what it also says about
  a thread that does not exist. So these assert the request against Meta's
  Handover Protocol reference, exactly as `send.test.ts` does for the send body.
*/
describe('takeThreadControlRequest', () => {
  it('addresses the recipient by their page-scoped id', () => {
    expect(takeThreadControlRequest({ recipientId: '4401096316575625' })).toEqual({
      recipient: { id: '4401096316575625' },
      metadata: TAKE_CONTROL_METADATA,
    });
  });

  it('names this system in the metadata the other app receives', () => {
    // Meta delivers `metadata` to the app losing control, in its own
    // `take_thread_control` webhook. It is the only thing we can put in front of
    // whoever is looking at that tool wondering why a thread went quiet.
    const body = takeThreadControlRequest({ recipientId: '1' });
    expect(body.metadata).toBe(TAKE_CONTROL_METADATA);
  });

  it('omits metadata rather than sending an empty one', () => {
    // A blank string is a value Graph carries through to the other app's
    // webhook, where it reads as a message somebody meant to write.
    expect(takeThreadControlRequest({ recipientId: '1', metadata: '' })).toEqual({
      recipient: { id: '1' },
    });
  });

  it('carries nothing else', () => {
    // The endpoint takes `recipient` and `metadata`. A stray field is the exact
    // failure this file exists to catch, and it is invisible in the response.
    expect(Object.keys(takeThreadControlRequest({ recipientId: '1' })).sort()).toEqual([
      'metadata',
      'recipient',
    ]);
  });
});
