import { describe, expect, it } from 'vitest';
import { cairo } from '@/lib/testing/time';
import { formatDateTime } from '@/lib/format';
import { inviteEmail } from './invite-email';

// Not `URL` — that shadows the global constructor for the whole module, so the
// next case that wants to parse the link gets a TypeError instead.
const INVITE_URL = 'https://support.shipblu.com/invite/JqL0-9_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';

const EXPIRES = cairo('2026-09-10T14:30');

function build(overrides: Partial<Parameters<typeof inviteEmail>[0]> = {}) {
  return inviteEmail({
    url: INVITE_URL,
    name: 'Mona Farouk',
    invitedByName: 'Ali Hassan',
    expiresAt: EXPIRES,
    ...overrides,
  });
}

describe('inviteEmail', () => {
  it('puts the activation link in both bodies and never in the subject', () => {
    const email = build();

    expect(email.htmlBody).toContain(`href="${INVITE_URL}"`);
    expect(email.textBody).toContain(INVITE_URL);

    // The subject is what a mail client prints on a lock screen and what a
    // notification relay keeps a copy of. The link is a credential.
    expect(email.subject).not.toContain(INVITE_URL);
    expect(email.subject).not.toContain('/invite/');
  });

  it('offers the bare URL as well as the button, for clients that flatten anchors', () => {
    const email = build();

    // Twice in the HTML: once as the anchor, once as copyable text. A client
    // that strips the anchor still leaves the recipient able to act.
    expect(email.htmlBody.split(INVITE_URL)).toHaveLength(3);
  });

  it('greets the invitee by the name the invite was raised with', () => {
    const email = build();

    // No unnamed case to cover: `invites.name` is NOT NULL and `createInvite`
    // rejects a blank one, so the greeting has exactly one shape.
    expect(email.textBody).toContain('Hi Mona Farouk,');
    expect(email.htmlBody).toContain('Hi Mona Farouk,');
  });

  it('falls back to the passive voice when the inviter is unknown', () => {
    const email = build({ invitedByName: null });

    expect(email.textBody).toContain('You have been invited');
    expect(email.textBody).not.toContain('null');
    expect(email.htmlBody).not.toContain('null');
  });

  it('names the inviter, which is the only thing a recipient can check', () => {
    expect(build().textBody).toContain('Ali Hassan has invited you');
  });

  it('escapes a name rather than letting it reach the markup', () => {
    const email = build({ name: "O'Brien <ops>", invitedByName: 'A & B' });

    expect(email.htmlBody).toContain('O&#39;Brien &lt;ops&gt;');
    expect(email.htmlBody).toContain('A &amp; B');
    expect(email.htmlBody).not.toContain('<ops>');

    // The text body is not markup and must keep the name as typed.
    expect(email.textBody).toContain("O'Brien <ops>");
  });

  it('states the expiry in Cairo time, from the deadline the row will enforce', () => {
    const email = build();

    // Against `formatDateTime` rather than a literal date string. The thing
    // worth pinning is the timezone — 14:30 Cairo, not the 11:30 the same
    // instant reads as in UTC — and `Intl`'s spelling of the month and its
    // choice of space character have both moved across CLDR releases, so a
    // hardcoded '10 Sept 2026, 14:30' turns red on an ICU bump for no reason.
    expect(email.textBody).toContain(formatDateTime(EXPIRES));
    expect(email.textBody).toContain('14:30');
    expect(email.textBody).toContain('(Cairo time)');
    expect(email.htmlBody).toContain(formatDateTime(EXPIRES));
  });

  it('tells the recipient that ignoring it costs them nothing', () => {
    const email = build();

    for (const body of [email.textBody, email.htmlBody]) {
      expect(body).toContain('not created until you set a password');
    }
  });
});
