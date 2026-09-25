import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { HoursConfig } from '@/lib/hours';
import { pickBody, pickRule, substitute, type AutoResponseRule } from './resolve';

/**
 * The decisions, not the plumbing: which rule wins when two match, which body a
 * holiday gets, and what a placeholder turns into.
 *
 * Instants are built from Cairo wall-clock and converted by the timezone
 * database rather than written as UTC by hand — Cairo observes DST again, so a
 * fixture written as "07:00 UTC is 09:00 in Cairo" is right for half the year.
 */

const cairo = (iso: string): Date => DateTime.fromISO(iso, { zone: 'Africa/Cairo' }).toJSDate();

const HOURS: HoursConfig = {
  timezone: 'Africa/Cairo',
  schedule: {
    sun: [{ start: '09:00', end: '17:00' }],
    mon: [{ start: '09:00', end: '17:00' }],
    tue: [{ start: '09:00', end: '17:00' }],
    wed: [{ start: '09:00', end: '17:00' }],
    thu: [{ start: '09:00', end: '17:00' }],
    fri: [],
    sat: [],
  },
  // A Sunday: a holiday landing on a working day, so it is the holiday and not
  // the weekend that closes the office.
  holidays: [{ date: '2026-03-22', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr' }],
};

function rule(overrides: Partial<AutoResponseRule> = {}): AutoResponseRule {
  return {
    id: 'r',
    groupId: null,
    channel: null,
    bodyAr: '',
    bodyEn: '',
    holidayBodyAr: '',
    holidayBodyEn: '',
    silent: false,
    ...overrides,
  };
}

const context = {
  locale: 'en',
  holiday: null,
  ticketNumber: 4210,
  customerName: 'Nour',
};

describe('pickRule', () => {
  it('matches a rule that names neither dimension against anything', () => {
    const company = rule({ id: 'company' });
    expect(pickRule([company], { groupId: 'g1', channel: 'email' })?.id).toBe('company');
    expect(pickRule([company], { groupId: null, channel: 'whatsapp' })?.id).toBe('company');
  });

  it('does not match a rule scoped to another group or channel', () => {
    const rules = [rule({ id: 'returns', groupId: 'g2' }), rule({ id: 'wa', channel: 'whatsapp' })];
    expect(pickRule(rules, { groupId: 'g1', channel: 'email' })).toBeNull();
  });

  it('prefers the channel rule over the group rule', () => {
    const rules = [
      rule({ id: 'company' }),
      rule({ id: 'group', groupId: 'g1' }),
      rule({ id: 'channel', channel: 'whatsapp' }),
    ];
    expect(pickRule(rules, { groupId: 'g1', channel: 'whatsapp' })?.id).toBe('channel');
  });

  it('prefers a rule naming both dimensions over either alone', () => {
    const rules = [
      rule({ id: 'channel', channel: 'whatsapp' }),
      rule({ id: 'group', groupId: 'g1' }),
      rule({ id: 'both', groupId: 'g1', channel: 'whatsapp' }),
    ];
    expect(pickRule(rules, { groupId: 'g1', channel: 'whatsapp' })?.id).toBe('both');
  });

  // The fallback is what makes turning a rule off safe: an admin disabling the
  // WhatsApp wording should get the company message back, not silence.
  it('falls through to the broader rule when the specific one is filtered out', () => {
    const active = [rule({ id: 'company' })];
    expect(pickRule(active, { groupId: 'g1', channel: 'whatsapp' })?.id).toBe('company');
  });

  it('matches a group rule for a ticket with no group only when the rule has none', () => {
    const rules = [rule({ id: 'group', groupId: 'g1' }), rule({ id: 'company' })];
    expect(pickRule(rules, { groupId: null, channel: 'email' })?.id).toBe('company');
  });
});

describe('pickBody', () => {
  const holiday = { date: '2026-03-20', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr' };

  it('sends the holiday body on a holiday', () => {
    const body = pickBody(rule({ bodyEn: 'closed', holidayBodyEn: 'eid' }), {
      ...context,
      holiday,
    });
    expect(body).toBe('eid');
  });

  // The override is optional, which is the whole reason it falls back.
  it('falls back to the out-of-hours body when no holiday body is written', () => {
    const body = pickBody(rule({ bodyEn: 'closed' }), { ...context, holiday });
    expect(body).toBe('closed');
  });

  it('never sends the holiday body off a holiday', () => {
    const body = pickBody(rule({ bodyEn: 'closed', holidayBodyEn: 'eid' }), context);
    expect(body).toBe('closed');
  });

  it('picks the language the customer writes in', () => {
    const both = rule({ bodyAr: 'مغلق', bodyEn: 'closed' });
    expect(pickBody(both, { ...context, locale: 'ar' })).toBe('مغلق');
    expect(pickBody(both, { ...context, locale: 'en' })).toBe('closed');
  });

  it('falls back to the other language rather than sending nothing', () => {
    expect(pickBody(rule({ bodyAr: 'مغلق' }), { ...context, locale: 'en' })).toBe('مغلق');
  });

  // Whitespace in a textarea is not a message. Without this, a row somebody
  // half-filled sends a blank reply.
  it('treats a whitespace-only body as unwritten', () => {
    expect(pickBody(rule({ bodyEn: '   \n  ' }), context)).toBeNull();
    expect(pickBody(rule(), context)).toBeNull();
  });

  it('falls back from an empty holiday body in one language to the other', () => {
    const body = pickBody(rule({ holidayBodyAr: 'عيد سعيد', bodyEn: 'closed' }), {
      ...context,
      locale: 'en',
      holiday,
    });
    expect(body).toBe('عيد سعيد');
  });
});

describe('substitute', () => {
  // Thursday 18:00 — the office shut an hour ago and does not open until Sunday.
  const thursdayEvening = cairo('2026-03-05T18:00');

  it('names the next opening in the customer’s language and the office timezone', () => {
    const text = substitute('We reply on {{next_opening}}.', HOURS, context, thursdayEvening);
    expect(text).toBe('We reply on Sunday at 09:00.');
  });

  it('translates the connector for an Arabic customer', () => {
    const text = substitute(
      'نرد عليك {{next_opening}}.',
      HOURS,
      { ...context, locale: 'ar' },
      thursdayEvening,
    );
    expect(text).toContain('الساعة 09:00');
    expect(text).not.toContain(' at ');
  });

  it('skips a holiday when working out when we next open', () => {
    // Thursday 19 March: Friday and Saturday are the weekend and Sunday is Eid,
    // so the next time anybody is here is Monday.
    const text = substitute('{{next_opening}}', HOURS, context, cairo('2026-03-19T19:00'));
    expect(text).toBe('Monday at 09:00');
  });

  it('interpolates the holiday name, the ticket number and the customer', () => {
    const text = substitute(
      'Hello {{customer_name}}, ticket #{{ticket_number}} — closed for {{holiday}}.',
      HOURS,
      { ...context, holiday: { date: '2026-03-22', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr' } },
      cairo('2026-03-22T11:00'),
    );
    expect(text).toBe('Hello Nour, ticket #4210 — closed for Eid al-Fitr.');
  });

  // The one placeholder whose value is itself translated. A body chosen for an
  // Arabic reader that names the day in Latin script is the half-localised
  // string this codebase already refuses in `formatOpening`.
  it('names the holiday in the language the message is written in', () => {
    const eid = { date: '2026-03-22', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr' };

    const arabic = substitute(
      'مغلق بمناسبة {{holiday}}.',
      HOURS,
      { ...context, locale: 'ar', holiday: eid },
      cairo('2026-03-22T11:00'),
    );
    expect(arabic).toBe('مغلق بمناسبة عيد الفطر.');
  });

  it('falls back to the name it has when only one language was written', () => {
    const arabicOnly = { date: '2026-03-22', nameAr: 'عيد الفطر' };

    const text = substitute(
      'Closed for {{holiday}}.',
      HOURS,
      { ...context, holiday: arabicOnly },
      cairo('2026-03-22T11:00'),
    );
    expect(text).toBe('Closed for عيد الفطر.');
  });

  // An unnamed holiday still closes the office; it just has nothing to
  // interpolate, and the sentence has to survive that.
  it('leaves nothing behind for a holiday with no name at all', () => {
    const text = substitute(
      'Closed for {{holiday}} today.',
      HOURS,
      { ...context, holiday: { date: '2026-03-22' } },
      cairo('2026-03-22T11:00'),
    );
    expect(text).toBe('Closed for today.');
  });

  // A template written for the holiday body still renders when the value is
  // missing, rather than leaving "closed for ." behind.
  it('closes the gap a missing value leaves', () => {
    const text = substitute(
      'Closed for {{holiday}} , back {{next_opening}}.',
      HOURS,
      { ...context, customerName: null, holiday: null },
      thursdayEvening,
    );
    expect(text).toBe('Closed for, back Sunday at 09:00.');
  });

  // The gap-closing is scoped to the placeholder, so an admin who lays a message
  // out with spaces gets the message they wrote. Collapsing runs of spaces over
  // the whole body reflowed this into a single line of prose.
  it('leaves the admin’s own spacing alone', () => {
    const text = substitute(
      ['Track your parcel:', '  •  shipblu.com/track', '  •  or reply here'].join('\n'),
      HOURS,
      context,
      thursdayEvening,
    );

    expect(text).toBe(
      ['Track your parcel:', '  •  shipblu.com/track', '  •  or reply here'].join('\n'),
    );
  });

  it('closes a gap between two words without touching the rest of the line', () => {
    const text = substitute(
      'Hello  {{customer_name}}  — ticket  #{{ticket_number}}',
      HOURS,
      { ...context, customerName: null },
      thursdayEvening,
    );

    expect(text).toBe('Hello — ticket  #4210');
  });

  it('leaves an unknown placeholder alone so a typo is visible', () => {
    const text = substitute('See {{nxt_opening}}.', HOURS, context, thursdayEvening);
    expect(text).toBe('See {{nxt_opening}}.');
  });

  it('tolerates spacing inside the braces', () => {
    const text = substitute('#{{ ticket_number }}', HOURS, context, thursdayEvening);
    expect(text).toBe('#4210');
  });

  // A schedule with no open time at all resolves to no opening. The sentence
  // has to survive that, because the alternative is sending "reply on null".
  it('drops the opening when the schedule never opens', () => {
    const closed: HoursConfig = {
      timezone: 'Africa/Cairo',
      schedule: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
    };
    const text = substitute('Back {{next_opening}}.', closed, context, thursdayEvening);
    expect(text).toBe('Back.');
  });
});
