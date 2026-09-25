import { describe, expect, it } from 'vitest';
import { MetaApiError } from './client';
import { explainMetaModerationError, explainMetaSendError, MetaSendRefusal } from './errors';

const UNKNOWN = 'An unknown error has occurred.';

function refusal(code: number | null, message = UNKNOWN, traceId: string | null = null) {
  return new MetaApiError(message, 400, code, null, true, null, traceId);
}

describe('explainMetaSendError', () => {
  it('explains a generic refusal of a human-agent reply', () => {
    const explained = explainMetaSendError(refusal(1), {
      platform: 'instagram',
      connection: 'instagram_login',
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

  /*
    The refusal production actually returns, read off message
    308729d0-4a39-4af4-bdff-5cca1b1c017f on 2026-09-06: `10 / HTTP 403` with the
    feature named in the message, not the unspecified 1/2 this branch was
    originally written for. It fell through every branch and printed Meta's
    sentence alone, which does not say that a role on the app is not the
    exemption here — the thing that cost the hour.
  */
  it('explains the named Human Agent refusal, which is what Graph really returns', () => {
    const named = new MetaApiError(
      "To use 'Human Agent', your use of this endpoint must be reviewed and approved by " +
        "Facebook. To submit this 'Human Agent' feature for review please read our " +
        'documentation on reviewable features: https://developers.facebook.com/docs/apps/review.',
      403,
      10,
      null,
      false,
      null,
      'AGtVAa9LUPmavPjHJ07bX3x',
    );

    const explained = explainMetaSendError(named, {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'dm',
      tag: 'HUMAN_AGENT',
    });

    expect(explained).toContain('App Review');
    // The two halves Meta's own sentence leaves out: that Standard Access does
    // not cover a feature, and which of the two connections' submissions this
    // one belongs to.
    expect(explained).toContain('Standard Access');
    expect(explained).toContain('instagram_business_*');
    expect(explained).toContain('trace AGtVAa9LUPmavPjHJ07bX3x');
  });

  /*
    The row it is written onto is `varchar(2000)` and the send handler truncates
    to fit. An explanation that overran would lose the reference line at the
    bottom — the trace id Meta support asks for — and lose it silently.
  */
  it('leaves room for the reference under the longest explanation', () => {
    const named = new MetaApiError(
      "To use 'Human Agent', your use of this endpoint must be reviewed and approved by " +
        "Facebook. To submit this 'Human Agent' feature for review please read our " +
        'documentation on reviewable features: https://developers.facebook.com/docs/apps/review.',
      403,
      10,
      null,
      false,
      null,
      'AGtVAa9LUPmavPjHJ07bX3x',
    );

    const explained = explainMetaSendError(named, {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'dm',
      tag: 'HUMAN_AGENT',
    });

    expect(explained.length).toBeLessThanOrEqual(2000);
  });

  it('does not blame the human agent tag when the reply was inside 24 hours', () => {
    const explained = explainMetaSendError(refusal(1), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toContain(UNKNOWN);
    expect(explained).not.toContain('App Review');
  });

  it('leaves a refusal that names its own rule alone', () => {
    const explained = explainMetaSendError(
      refusal(10, 'This message is sent outside of allowed window'),
      { platform: 'facebook', connection: 'facebook_page', sendKind: 'dm', tag: 'HUMAN_AGENT' },
    );

    expect(explained).toContain('outside of allowed window');
    expect(explained).not.toContain('App Review');
  });

  it('says a token is expired rather than leaving it to be read as a send problem', () => {
    const explained = explainMetaSendError(
      refusal(190, 'Error validating access token: Session has expired'),
      { platform: 'facebook', connection: 'facebook_page', sendKind: 'comment_reply' },
    );

    expect(explained).toContain('META_PAGE_ACCESS_TOKEN');
  });

  it('keeps the identifiers Meta support asks for', () => {
    const explained = explainMetaSendError(refusal(1, UNKNOWN, 'Az9trace'), {
      platform: 'instagram',
      connection: 'instagram_login',
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
      connection: 'facebook_page',
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
    const ours = new MetaSendRefusal('Another app holds thread control.');

    const explained = explainMetaSendError(ours, {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toBe('Another app holds thread control.');
    expect(explained).not.toContain('Meta:');
  });

  /*
    The 7-day refusal is raised with an HTTP 400 so the job treats it the way it
    treats any final rejection. That made it indistinguishable from a Graph
    answer by shape, and it printed `(Meta: code —, subcode —, HTTP 400)` under
    a sentence Meta never sent — which points whoever reads it at Meta's logs
    for a request that was never made.
  */
  it('does not print a reference under our own refusal that carries a status', () => {
    const ours = new MetaSendRefusal('The 7-day messaging window has closed.', 400);

    const explained = explainMetaSendError(ours, {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'dm',
      tag: 'HUMAN_AGENT',
    });

    expect(explained).toBe('The 7-day messaging window has closed.');
    expect(explained).not.toContain('Meta:');
  });

  /*
    The shape lib/meta/client.ts actually raises when `fetch` throws: status 0,
    no code. It has to survive the classifier untouched — a null code otherwise
    reads as one of Meta's unspecified refusals, and the reply would be told the
    24-hour window is in order when nothing was ever asked.
  */
  it('leaves a network failure as the sentence that names the cause', () => {
    const unreachable = new MetaApiError(
      'Graph API unreachable: socket hang up',
      0,
      null,
      null,
      true,
    );

    const explained = explainMetaSendError(unreachable, {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toBe('Graph API unreachable: socket hang up');
    expect(explained).not.toContain('Meta:');
    expect(explained).not.toContain('24-hour window');
  });

  it('still prints the reference when Graph answered with a 5xx', () => {
    const explained = explainMetaSendError(new MetaApiError('Internal error', 503, 2, null, true), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toContain('HTTP 503');
  });

  it('prefers the wording Meta wrote for a person, when there is any', () => {
    const error = new MetaApiError(UNKNOWN, 400, 1, null, true, 'Try again in a few minutes.');

    const explained = explainMetaSendError(error, {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).toContain('Try again in a few minutes.');
  });
});

describe('explainMetaModerationError', () => {
  /** How Graph refuses a POST the app is not approved for. */
  const unsupportedPost = () =>
    new MetaApiError('Unsupported post request.', 400, 100, 33, false, null, 'AaBb');

  it('names the Instagram permission for the connection the call went out on', () => {
    /*
      One spelling, not both, and this changed once both connections went live.

      The permission is `instagram_business_manage_comments` for Instagram Login
      and `instagram_manage_comments` for a Page-connected account, and this app
      holds both connections — so offering both names for one refusal is how an
      approval gets requested against the flow that was not being used. The call
      knows which host it went to; that decides which name to print.
    */
    const direct = explainMetaModerationError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'instagram_login',
      action: 'hide',
    });

    expect(direct).toContain('instagram_business_manage_comments');
    expect(direct).toContain('graph.instagram.com');
    expect(direct).toContain('hide');

    const page = explainMetaModerationError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'facebook_page',
      action: 'hide',
    });

    expect(page).toContain('instagram_manage_comments');
    expect(page).not.toContain('instagram_business_manage_comments');
    expect(page).toContain('graph.facebook.com');
  });

  it('names the Page permission on Facebook', () => {
    const explained = explainMetaModerationError(unsupportedPost(), {
      platform: 'facebook',
      connection: 'facebook_page',
      action: 'delete',
    });

    expect(explained).toContain('pages_manage_engagement');
    expect(explained).not.toContain('instagram');
  });

  it('keeps the numbers Meta support asks for', () => {
    expect(
      explainMetaModerationError(unsupportedPost(), {
        platform: 'instagram',
        connection: 'instagram_login',
        action: 'unhide',
      }),
    ).toContain('trace AaBb');
  });

  it('leaves a refusal that is not about permissions alone', () => {
    const rateLimited = new MetaApiError(
      'Calls to this api have exceeded the rate limit',
      400,
      613,
      null,
      true,
    );

    const explained = explainMetaModerationError(rateLimited, {
      platform: 'instagram',
      connection: 'instagram_login',
      action: 'hide',
    });

    expect(explained).toContain('exceeded the rate limit');
    expect(explained).not.toContain('App Review');
  });
});

describe('a reply to a comment Graph will not accept', () => {
  /** How Graph refuses a POST to a node that is gone. */
  const unsupportedPost = () =>
    new MetaApiError('Unsupported post request.', 400, 100, 33, false, null, 'AaBb');

  it('names the deleted comment first, because nothing else ever will', () => {
    /*
      Established by deleting a real comment on 2026-08-30 and watching the
      Render request log: Instagram sends no webhook for a deletion — no verb,
      no empty change, no request. So the ticket goes on showing the comment and
      this refusal is the only signal an agent ever gets. Before this branch it
      printed "Unsupported post request." and a code, which reads as a broken
      integration rather than as a customer changing their mind.
    */
    const explained = explainMetaSendError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'comment_reply',
    });

    expect(explained).toContain('The comment is gone');
    expect(explained).toContain('no webhook when a comment is deleted');
    // Ordered by likelihood: the approval fails every comment reply, not this one.
    expect(explained.indexOf('The comment is gone')).toBeLessThan(
      explained.indexOf('The approval'),
    );
  });

  it('names the permission for the connection the reply went out over', () => {
    const direct = explainMetaSendError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'comment_reply',
    });
    expect(direct).toContain('instagram_business_manage_comments');

    const page = explainMetaSendError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'facebook_page',
      sendKind: 'comment_reply',
    });
    expect(page).toContain('instagram_manage_comments');
    expect(page).not.toContain('instagram_business_manage_comments');
  });

  it('raises the one-level-deep thread only where it can happen', () => {
    // Instagram's `replies` edge belongs to the root comment alone. Facebook has
    // no such rule, so offering it there would be a wrong lead.
    const instagram = explainMetaSendError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'comment_reply',
    });
    expect(instagram).toContain('one level deep');

    const facebook = explainMetaSendError(unsupportedPost(), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'comment_reply',
    });
    expect(facebook).not.toContain('one level deep');
    expect(facebook).toContain('pages_manage_engagement');
  });

  it('adds the once-ever rule for a private reply', () => {
    // The one send in the product that cannot be retried, and it is refused in
    // this same shape when it has already been used.
    const explained = explainMetaSendError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'private_reply',
    });

    expect(explained).toContain('exactly once per comment');
    expect(explained).toContain('seven days');
  });

  it('leaves a direct message alone', () => {
    // The branch is scoped to comment sends. A DM refused with 100 has its own
    // causes and this sentence would be a wrong lead.
    const explained = explainMetaSendError(unsupportedPost(), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).not.toContain('The comment is gone');
  });

  it('stays quiet on a code it was not written for', () => {
    // Silent beats confidently wrong: nothing here has been observed against the
    // real Graph, so an unfamiliar refusal keeps Meta's own words.
    const rateLimited = new MetaApiError('Rate limit', 400, 613, null, true, null, 'AaBb');
    const explained = explainMetaSendError(rateLimited, {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'comment_reply',
    });

    expect(explained).not.toContain('The comment is gone');
  });
});

describe('a comment reply the app is not approved to make', () => {
  /**
   * The real one, copied from production rather than imagined: ticket #13755,
   * 2026-09-01 12:25:01 UTC, `POST /1261963959273229_1084459191222048/comments`
   * answered `HTTP 403` with code 200 and the words below. It was the first
   * comment reply this system had ever attempted, and it fell through every
   * branch to the generic one — the agent's timeline read "(#200) Permissions
   * error" and stopped there.
   */
  const permissionsError = () =>
    new MetaApiError('(#200) Permissions error', 403, 200, null, false, null, 'AT9Pvg');

  it('says the app was refused, not the comment', () => {
    const explained = explainMetaSendError(permissionsError(), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'comment_reply',
    });

    expect(explained).toContain('(#200) Permissions error');
    expect(explained).toContain('pages_manage_engagement');
    expect(explained).toContain('Advanced Access');
    expect(explained).toContain('check_meta_permissions');

    // The opposite diagnosis, and the one an agent would waste the afternoon on:
    // this code says nothing about whether the customer deleted anything.
    expect(explained).not.toContain('The comment is gone');
  });

  it('says it fails every reply, which is what makes it worth checking first', () => {
    const explained = explainMetaSendError(permissionsError(), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'comment_reply',
    });

    expect(explained).toContain('every');
    expect(explained).toContain('if a reply has ever succeeded here, look elsewhere');
  });

  it('names the permission belonging to the connection the send went out over', () => {
    const direct = explainMetaSendError(permissionsError(), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'comment_reply',
    });
    expect(direct).toContain('instagram_business_manage_comments');

    const page = explainMetaSendError(permissionsError(), {
      platform: 'instagram',
      connection: 'facebook_page',
      sendKind: 'comment_reply',
    });
    expect(page).toContain('instagram_manage_comments');
    expect(page).not.toContain('instagram_business_manage_comments');
  });

  it('covers the other two codes Graph refuses an app with', () => {
    // 3 and 10 are the same refusal in different words — the profile lookups
    // already treat all three as one thing, and this path sees the same Graph.
    for (const code of [3, 10]) {
      const explained = explainMetaSendError(
        new MetaApiError('Permissions error', 403, code, null, false, null, 'AaBb'),
        { platform: 'facebook', connection: 'facebook_page', sendKind: 'comment_reply' },
      );
      expect(explained).toContain('pages_manage_engagement');
    }
  });

  it('offers the private reply as the way through, but not to a private reply', () => {
    const publicReply = explainMetaSendError(permissionsError(), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'comment_reply',
    });
    expect(publicReply).toContain('Reply privately');

    // Suggesting it to somebody whose private reply just failed would be a loop.
    const privateReply = explainMetaSendError(permissionsError(), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'private_reply',
    });
    expect(privateReply).not.toContain('Reply privately');

    /*
      And it names the messaging approval rather than the comment one. A private
      reply goes out through the messages endpoint, so `pages_manage_engagement`
      would not have changed the answer — the sentence this replaces said the two
      shared an approval, which would have sent an agent after the wrong grant.
    */
    expect(privateReply).toContain('pages_messaging');
    expect(privateReply).not.toContain('pages_manage_engagement');
  });

  it('leaves a direct message alone: this branch is about the comment edges', () => {
    const explained = explainMetaSendError(permissionsError(), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'dm',
      tag: 'RESPONSE',
    });

    expect(explained).not.toContain('pages_manage_engagement');
  });
});

describe('thread control', () => {
  /*
    The refusal that produced this: two Facebook private replies on 2026-09-02,
    both `10 / 2018300`, both explained as a missing messaging permission because
    code 10 is one of the three the comment branch claims. Meta's own sentence
    said what was wrong; the explanation underneath contradicted it.
  */
  const handover = () =>
    new MetaApiError(
      'Message failed to send because another app is controlling this thread now.',
      400,
      10,
      2018300,
      false,
      null,
      'AqKQR',
    );

  it('reads 10/2018300 as handover and not as a permission', () => {
    const explained = explainMetaSendError(handover(), {
      platform: 'facebook',
      connection: 'facebook_page',
      sendKind: 'private_reply',
    });

    expect(explained).toContain('thread control');
    expect(explained).toContain('not a permission problem');
    // The branch it has to win against, and the advice that would waste a day.
    expect(explained).not.toContain('pages_messaging');
    expect(explained).not.toContain('check_meta_permissions');
  });

  it('still explains a bare code 10 as the permission refusal it is', () => {
    // The subcode is the only thing separating the two, so a 10 without one must
    // keep reaching the branch it always did.
    const explained = explainMetaSendError(
      new MetaApiError('Permissions error', 403, 10, null, false, null, 'AaBb'),
      { platform: 'facebook', connection: 'facebook_page', sendKind: 'comment_reply' },
    );

    expect(explained).toContain('pages_manage_engagement');
    expect(explained).not.toContain('thread control');
  });

  it('offers the direct Instagram connection only when the Page is the route', () => {
    const viaPage = explainMetaSendError(handover(), {
      platform: 'instagram',
      connection: 'facebook_page',
      sendKind: 'private_reply',
    });
    expect(viaPage).toContain('INSTAGRAM_ACCESS_TOKEN');

    /*
      Already on the direct connection, where the Page's handover does not apply
      — observed the same day: a private reply over `instagram_login` was
      delivered in the minute a Facebook one was refused this way. Suggesting the
      escape it is already using would be nonsense.
    */
    const direct = explainMetaSendError(handover(), {
      platform: 'instagram',
      connection: 'instagram_login',
      sendKind: 'private_reply',
    });
    expect(direct).not.toContain('INSTAGRAM_ACCESS_TOKEN');
  });
});
