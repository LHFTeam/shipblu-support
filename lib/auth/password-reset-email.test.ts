import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/format';
import { cairo } from '@/lib/testing/time';
import { agentPasswordResetEmail, passwordChangedEmail } from './password-reset-email';

// Not `URL`, which would shadow the global constructor for the whole module.
const RESET_URL = 'https://support.shipblu.com/reset/JqL0-9_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
const EXPIRES = cairo('2026-11-26T14:30');

function build(name = 'Mona Farouk') {
  return agentPasswordResetEmail({ url: RESET_URL, name, expiresAt: EXPIRES });
}

describe('agentPasswordResetEmail', () => {
  it('puts the link in both bodies and never in the subject', () => {
    const email = build();

    expect(email.htmlBody).toContain(`href="${RESET_URL}"`);
    expect(email.textBody).toContain(RESET_URL);
    // The subject is what a lock screen prints. The link is the account.
    expect(email.subject).not.toContain('http');
    expect(email.subject).not.toContain('reset/');
  });

  it('carries the link once in the text, so a reader cannot copy half of two', () => {
    expect(build().textBody.split(RESET_URL)).toHaveLength(2);
  });

  it("prints the link's own expiry, in Cairo, and that it works once", () => {
    const email = build();
    const expiry = `expires on ${formatDateTime(EXPIRES)} (Cairo time)`;

    expect(email.textBody).toContain(expiry);
    expect(email.htmlBody).toContain(expiry);
    expect(email.textBody).toContain('works once');
  });

  it('says what ignoring it costs, for the reader who did not ask', () => {
    const email = build();

    expect(email.textBody).toContain('your current password is unchanged');
    expect(email.htmlBody).toContain('your current password is unchanged');
    // "Somebody asked", not "you asked": the reader is often not the asker.
    expect(email.textBody).toContain('Somebody asked');
  });

  it('escapes the name in the HTML and leaves it as typed in the text', () => {
    const email = build('<b>Mona</b> & co');

    expect(email.htmlBody).toContain('&lt;b&gt;Mona&lt;/b&gt; &amp; co');
    expect(email.htmlBody).not.toContain('<b>Mona</b>');
    expect(email.textBody).toContain('Hi <b>Mona</b> & co,');
  });
});

describe('passwordChangedEmail', () => {
  it('carries no link at all', () => {
    const email = passwordChangedEmail({ name: 'Mona Farouk' });

    // It rides in a job's payload, where a link would be a credential at rest,
    // and a "was this you?" email with a button is what phishing looks like.
    expect(email.textBody).not.toContain('http');
    expect(email.htmlBody).not.toContain('href');
  });

  it('says what happened and whom to tell', () => {
    const email = passwordChangedEmail({ name: '<Mona>' });

    expect(email.subject).toBe('Your ShipBlu Support password was changed');
    expect(email.textBody).toContain('every device was signed out');
    expect(email.textBody).toContain('tell an administrator');
    expect(email.htmlBody).toContain('Hi &lt;Mona&gt;,');
  });
});
