import { describe, expect, it } from 'vitest';
import {
  lowRatingEmail,
  lowRatingRecipients,
  namesAgentTo,
  type AlertCandidate,
} from './low-rating';

function candidate(over: Partial<AlertCandidate> & { id: string }): AlertCandidate {
  return {
    email: `${over.id}@shipblu.test`,
    role: 'supervisor',
    permissions: {},
    isActive: true,
    activated: true,
    ...over,
  };
}

describe('lowRatingRecipients', () => {
  it('takes everybody who can both read the ratings and open any ticket, by role or override', () => {
    const picked = lowRatingRecipients([
      candidate({ id: 'supervisor' }),
      candidate({ id: 'admin', role: 'admin' }),
      candidate({ id: 'owner', role: 'account_admin' }),
      // An agent given both by hand is somebody whose job includes this.
      candidate({
        id: 'trusted-agent',
        role: 'agent',
        permissions: { 'report.view': true, 'ticket.view.all': true },
      }),
    ]);
    expect(picked.map((agent) => agent.id)).toEqual([
      'supervisor',
      'admin',
      'owner',
      'trusted-agent',
    ]);
  });

  it('leaves out anybody holding only one of the two', () => {
    const picked = lowRatingRecipients([
      // Reads the numbers, may not open the ticket the email points at.
      candidate({ id: 'reports-only', permissions: { 'ticket.view.all': false } }),
      // Sees the whole queue, was not given the ratings.
      candidate({ id: 'queue-only', permissions: { 'report.view': false } }),
      candidate({ id: 'agent', role: 'agent' }),
      candidate({ id: 'agent-with-reports', role: 'agent', permissions: { 'report.view': true } }),
    ]);
    expect(picked).toEqual([]);
  });

  it('leaves out a deactivated agent and one who never set a password', () => {
    const picked = lowRatingRecipients([
      candidate({ id: 'gone', isActive: false }),
      candidate({ id: 'invited', activated: false }),
      candidate({ id: 'here' }),
    ]);
    expect(picked.map((agent) => agent.id)).toEqual(['here']);
  });
});

describe('namesAgentTo', () => {
  it('follows the report: `report.agents`, by role or override', () => {
    expect(namesAgentTo(candidate({ id: 'supervisor' }))).toBe(true);
    expect(namesAgentTo(candidate({ id: 'admin', role: 'admin' }))).toBe(true);
    // Given the report and the queue, not the people.
    expect(
      namesAgentTo(
        candidate({
          id: 'trusted-agent',
          role: 'agent',
          permissions: { 'report.view': true, 'ticket.view.all': true },
        }),
      ),
    ).toBe(false);
    // The case the key was split out for: reporting kept, the people taken away.
    expect(
      namesAgentTo(candidate({ id: 'coach-less', permissions: { 'report.agents': false } })),
    ).toBe(false);
  });
});

describe('lowRatingEmail', () => {
  const alert = {
    number: 1234,
    rating: 1,
    agentName: 'Sara',
    groupName: 'Returns',
    url: 'https://console.shipblu.test/inbox/1234',
    namesAgent: true,
  };

  it('names the ticket, the score and the link, in both bodies', () => {
    const email = lowRatingEmail(alert);
    expect(email.subject).toBe('Ticket #1234 was rated 1 / 5');
    for (const body of [email.textBody, email.htmlBody]) {
      expect(body).toContain('Ticket #1234 was rated 1 / 5 by the customer.');
      expect(body).toContain('Agent: Sara');
      expect(body).toContain('Group: Returns');
      expect(body).toContain('https://console.shipblu.test/inbox/1234');
    }
    expect(email.htmlBody).toContain('href="https://console.shipblu.test/inbox/1234"');
  });

  it('names the agent only in the copy for somebody the report names agents to', () => {
    const email = lowRatingEmail({ ...alert, namesAgent: false });
    for (const body of [email.subject, email.textBody, email.htmlBody]) {
      expect(body).not.toContain('Agent:');
      expect(body).not.toContain('Sara');
    }
    expect(email.textBody).toContain('Group: Returns');
    expect(email.textBody).toContain('https://console.shipblu.test/inbox/1234');
  });

  it('says no agent is on record rather than printing null, or guessing why', () => {
    const email = lowRatingEmail({ ...alert, agentName: null, groupName: null });
    // Null is nobody assigned, or an agent since removed: the row cannot say
    // which, so the email claims neither.
    expect(email.textBody).toContain('Agent: none on record');
    expect(email.textBody).toContain('Group: none');
    expect(email.textBody).not.toContain('null');
  });

  it('escapes the names an admin typed', () => {
    const email = lowRatingEmail({
      ...alert,
      agentName: 'O’Brien <ops>',
      groupName: 'Hub "A" & B',
    });
    expect(email.htmlBody).toContain('O’Brien &lt;ops&gt;');
    expect(email.htmlBody).toContain('Hub &quot;A&quot; &amp; B');
    expect(email.htmlBody).not.toContain('<ops>');
    // The text body is not HTML, and says them as they are.
    expect(email.textBody).toContain('Agent: O’Brien <ops>');
  });
});
