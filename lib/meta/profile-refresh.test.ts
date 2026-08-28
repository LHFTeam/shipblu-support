import { describe, expect, it } from 'vitest';
import { MetaApiError } from './client';
import { describeProfileRefresh, type ProfileRefreshResult } from './profile-refresh';

/**
 * An `applied` result with the fields this suite does not care about filled in.
 *
 * The locale and gender that ride along on that result are a property of the
 * profile call, not of the sentence being asserted here, so they are defaulted
 * rather than repeated in every case.
 */
function applied(
  over: Partial<Extract<ProfileRefreshResult, { kind: 'applied' }>>,
): ProfileRefreshResult {
  return {
    kind: 'applied',
    name: null,
    picture: 'none',
    locale: null,
    gender: false,
    extendedFieldsRefused: false,
    ...over,
  };
}

/**
 * What the agent is told, which on this feature is the entire product.
 *
 * The console's retry button exists because a refusal was only ever written to
 * a worker log nobody was reading — 17 of them before anyone noticed the app
 * had never been approved. So the sentence this produces is not decoration: it
 * is the thing that carries a Meta diagnosis from the queue to the person who
 * can act on it, and the failure mode worth testing is a success message that
 * over-claims or a refusal that loses Meta's own words on the way.
 */
describe('describeProfileRefresh', () => {
  it('keeps Meta’s own explanation intact on a refusal', () => {
    const reason =
      'Application does not have the capability to make this API call.\n\n' +
      'Graph refused a Messenger profile read.';

    const said = describeProfileRefresh({ kind: 'refused', reason, permission: true });

    // Verbatim, not summarised. An agent reads this out to whoever holds the
    // Meta dashboard, and a paraphrase is the version that cannot be searched
    // for in Meta's own documentation.
    expect(said).toBe(reason);
  });

  it('does not claim a name when Meta had none to give', () => {
    const said = describeProfileRefresh(applied({ name: null, picture: 'none' }));

    expect(said).toContain('no name or picture');
    // The bug this guards: "Got null" or a cheerful success that leaves the
    // agent looking for a name that was never written.
    expect(said).not.toContain('null');
    expect(said).not.toMatch(/^Got\b/);
  });

  it('tells the agent to ask again when only the picture failed', () => {
    // The name is already saved at this point, so "failed" would be wrong and
    // an unqualified success would leave a contact permanently faceless while
    // Meta holds a picture for them.
    const said = describeProfileRefresh(applied({ name: 'Layla', picture: 'retry' }));

    expect(said).toContain('Layla');
    expect(said).toContain('try again');
  });

  it('separates a name with a picture from a name without one', () => {
    const withPicture = describeProfileRefresh(applied({ name: 'Ali Hassan', picture: 'stored' }));
    const withoutPicture = describeProfileRefresh(applied({ name: 'Ali Hassan', picture: 'none' }));

    expect(withPicture).toContain('picture');
    expect(withoutPicture).not.toContain('picture');
  });

  it('names the missing variables when nothing is configured', () => {
    const said = describeProfileRefresh({
      kind: 'unconfigured',
      detail: 'META_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID',
    });

    // Not "not configured" alone: the point of the sentence is that somebody
    // can go and set the thing it names.
    expect(said).toContain('META_PAGE_ACCESS_TOKEN');
    expect(said).toContain('FACEBOOK_PAGE_ID');
  });

  it('invites a second attempt only when one could succeed', () => {
    const transient = describeProfileRefresh({
      kind: 'transient',
      error: new MetaApiError('please reduce the rate', 400, 613, null, true),
    });
    expect(transient).toContain('Try again');

    // A merged-away contact is not a retry: clicking again produces the same
    // answer forever, and the useful information is where the record went.
    const gone = describeProfileRefresh({ kind: 'gone' });
    expect(gone).toContain('merged');
    expect(gone).not.toContain('Try again');
  });

  it('answers for every outcome the refresh can return', () => {
    // A new `kind` added to the union without a sentence here would be a button
    // that silently says nothing, which is the failure this whole feature was
    // written to end. `tsc` catches the switch; this catches an empty string.
    const all: ProfileRefreshResult[] = [
      { kind: 'gone' },
      { kind: 'skipped' },
      { kind: 'unconfigured', detail: 'X' },
      { kind: 'refused', reason: 'no', permission: false },
      { kind: 'transient', error: new MetaApiError('later', 500, null, null, true) },
      applied({ name: 'A', picture: 'stored' }),
      applied({ name: null, picture: 'none' }),
    ];

    for (const result of all) {
      expect(describeProfileRefresh(result).trim().length).toBeGreaterThan(0);
    }
  });
});
