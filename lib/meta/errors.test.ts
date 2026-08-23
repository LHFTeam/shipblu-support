import { describe, expect, it } from 'vitest';
import { MetaApiError } from './client';
import { explainMetaSendError } from './errors';

const UNKNOWN = 'An unknown error has occurred.';

function refusal(code: number | null, message = UNKNOWN, traceId: string | null = null) {
  return new MetaApiError(message, 400, code, null, true, null, traceId);
}

describe('explainMetaSendError', () => {
  it('explains a generic refusal of a human-agent reply', () => {
    const explained = explainMetaSendError(refusal(1), {
      platform: 'instagram',
      sendKind: 'dm',
      tag: 'HUMAN_AGENT',
    });

    // Meta's own sentence stays: an agent comparing the timeline to a Meta
    // dashboard should find the same words in both.
    expect(explained).toContain(UNKNOWN);
    expect(explained).toContain('HUMAN_AGENT');
    expect(explained).toContain('Human Agent');
    expect(explained).toContain('Instagram');
  });

  it('does not blame the human agent tag when the reply was inside 24 hours', () => {
    const explained = explainMetaSendError(refusal(1), {
      platform: 'instagram',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toContain(UNKNOWN);
    expect(explained).not.toContain('App Review');
  });

  it('leaves a refusal that names its own rule alone', () => {
    const explained = explainMetaSendError(
      refusal(10, 'This message is sent outside of allowed window'),
      { platform: 'facebook', sendKind: 'dm', tag: 'HUMAN_AGENT' },
    );

    expect(explained).toContain('outside of allowed window');
    expect(explained).not.toContain('App Review');
  });

  it('says a token is expired rather than leaving it to be read as a send problem', () => {
    const explained = explainMetaSendError(
      refusal(190, 'Error validating access token: Session has expired'),
      { platform: 'facebook', sendKind: 'comment_reply' },
    );

    expect(explained).toContain('META_PAGE_ACCESS_TOKEN');
  });

  it('keeps the identifiers Meta support asks for', () => {
    const explained = explainMetaSendError(refusal(1, UNKNOWN, 'Az9trace'), {
      platform: 'instagram',
      sendKind: 'dm',
      tag: 'HUMAN_AGENT',
    });

    expect(explained).toContain('code 1');
    expect(explained).toContain('HTTP 400');
    expect(explained).toContain('trace Az9trace');
  });

  it('says what has already been ruled out for a refusal inside the window', () => {
    const explained = explainMetaSendError(refusal(1), {
      platform: 'facebook',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toContain('24-hour window');
    expect(explained).toContain('holds control');
    // The tag explanation is the wrong one here and must not appear.
    expect(explained).not.toContain('App Review');
  });

  /*
    A refusal this app made itself — a thread another tool owns, a page it
    cannot address — never reached Graph, so there is no code, subcode or trace
    to quote. Printing the empty reference under it reads as Meta having
    answered, which sends whoever debugs it to Meta's logs for a request that
    was never made.
  */
  it('does not print an empty Meta reference under our own refusal', () => {
    const ours = new MetaApiError('Another app holds thread control.', 0, null, null, false);

    const explained = explainMetaSendError(ours, {
      platform: 'facebook',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toBe('Another app holds thread control.');
    expect(explained).not.toContain('Meta:');
  });

  it('still prints the reference for a network failure that carries a status', () => {
    const unreachable = new MetaApiError(
      'Graph API unreachable: socket hang up',
      503,
      2,
      null,
      true,
    );

    const explained = explainMetaSendError(unreachable, {
      platform: 'facebook',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toContain('HTTP 503');
  });

  it('prefers the wording Meta wrote for a person, when there is any', () => {
    const error = new MetaApiError(UNKNOWN, 400, 1, null, true, 'Try again in a few minutes.');

    const explained = explainMetaSendError(error, {
      platform: 'instagram',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toContain('Try again in a few minutes.');
  });
});
