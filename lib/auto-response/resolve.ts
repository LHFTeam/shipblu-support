import { formatOpening, nextOpeningAt, type Holiday, type HoursConfig } from '@/lib/hours';

/**
 * Choosing the out-of-hours message: which rule applies, which body it sends,
 * and what the placeholders in it stand for.
 *
 * Pure, and apart from the queries that load it (`./index`), for the same reason
 * `lib/hours/resolve.ts` is: this is the part with the decisions in it, and the
 * decisions are worth testing without a database. Everything here is a function
 * of the rules, the ticket's scope and the calendar — nothing reads the clock
 * except through the `at` it is handed.
 */

export type AutoResponseRule = {
  id: string;
  groupId: string | null;
  channel: string | null;
  bodyAr: string;
  bodyEn: string;
  holidayBodyAr: string;
  holidayBodyEn: string;
  silent: boolean;
};

/**
 * The rule that applies to a ticket, or null.
 *
 * A rule matches when every dimension it names matches; a dimension it leaves
 * null matches anything. The winner is the most specific match — both dimensions
 * beat one, and a channel beats a group.
 *
 * Channel over group is the one arbitrary choice in here, and it is arbitrary
 * only in the sense that either could be defended. It goes this way because the
 * two scopes are usually reached for at different times: a group rule is set up
 * once, when a team is created, and a channel rule is written *later*, when
 * somebody reads the company message on a phone and decides WhatsApp needs its
 * own two lines. The later, narrower intent should be the one that wins, and an
 * admin who disagrees can say so exactly by setting both dimensions on one rule.
 *
 * Rules the caller has already filtered to `isActive`; an inactive rule is not
 * a match at all, so a ticket falls through to the next broadest one rather
 * than to silence — which is what makes turning a rule off a safe thing to do.
 */
export function pickRule(
  rules: AutoResponseRule[],
  scope: { groupId: string | null; channel: string },
): AutoResponseRule | null {
  let best: AutoResponseRule | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    if (rule.groupId !== null && rule.groupId !== scope.groupId) continue;
    if (rule.channel !== null && rule.channel !== scope.channel) continue;

    // Channel 2, group 1: a rule naming both scores 3 and outranks either alone.
    const score = (rule.channel !== null ? 2 : 0) + (rule.groupId !== null ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Which language to answer in.
 *
 * `contacts.locale` is `not null default 'en'`, so 'en' means either "this
 * person reads English" or "nobody has ever said" — the distinction
 * `lib/contacts/merge.ts` already draws, and nothing in the product sets the
 * column, so today every one of the 6,000-odd contacts reads as the second.
 * Taking it at face value would answer an Arabic-first customer base in English
 * on every channel, which is the failure this project calls silent success: a
 * message goes out, a count goes up, and it is wrong in one direction only.
 *
 * So an explicitly Arabic contact is honoured, and everybody else is read from
 * the script of what they actually wrote. Counting letters rather than looking
 * for the first Arabic character is what keeps "SB123456 فين شحنتي" Arabic and
 * "my order to شبرا" English — an address or a name in the other alphabet is
 * not a change of language.
 */
export function preferredLocale(contactLocale: string, sample: string | null): 'ar' | 'en' {
  if (contactLocale === 'ar') return 'ar';
  if (!sample) return 'en';

  const arabic = sample.match(
    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g,
  );
  const latin = sample.match(/[A-Za-z]/g);

  return (arabic?.length ?? 0) > (latin?.length ?? 0) ? 'ar' : 'en';
}

export type MessageContext = {
  locale: string;
  /** The holiday the ticket arrived on, if it arrived on one. */
  holiday: Holiday | null;
  ticketNumber: number;
  customerName: string | null;
};

/**
 * The body to send, before substitution — or null when the rule has nothing to
 * say in any language.
 *
 * Two fallbacks, and both exist so that filling in one field is a complete
 * configuration. A missing holiday body falls back to the ordinary out-of-hours
 * one, which is what makes the holiday override optional. A missing translation
 * falls back to the other language, because a customer reading a message in the
 * wrong language is a worse outcome for exactly nobody than silence is.
 */
export function pickBody(rule: AutoResponseRule, context: MessageContext): string | null {
  const arabic = context.locale === 'ar';

  const holiday = arabic
    ? [rule.holidayBodyAr, rule.holidayBodyEn]
    : [rule.holidayBodyEn, rule.holidayBodyAr];
  const ordinary = arabic ? [rule.bodyAr, rule.bodyEn] : [rule.bodyEn, rule.bodyAr];

  const candidates = context.holiday ? [...holiday, ...ordinary] : ordinary;

  return candidates.map((body) => body.trim()).find(Boolean) ?? null;
}

/**
 * What each placeholder stands for on this ticket.
 *
 * `{{next_opening}}` is the one that earns the whole mechanism: "we are closed"
 * is an apology, and "we are closed, we will reply on Sunday at 09:00" is an
 * answer. It is computed off the same calendar that decided the office was shut,
 * so the two cannot disagree, and it is formatted in the schedule's timezone
 * rather than the server's — a customer in Cairo being told a UTC opening time
 * is being told the wrong time twice a year, and the wrong time by two hours the
 * rest of it.
 *
 * An unknown placeholder is left alone rather than blanked. A typo should look
 * like a typo in the admin screen's preview, not like a message that silently
 * lost a sentence.
 */
export function substitute(
  body: string,
  hours: HoursConfig,
  context: MessageContext,
  at: Date,
): string {
  const opening = nextOpeningAt(hours, at);

  const values: Record<string, string | null> = {
    next_opening: opening ? formatOpening(opening, hours.timezone, context.locale) : null,
    holiday: context.holiday?.name ?? null,
    ticket_number: String(context.ticketNumber),
    customer_name: context.customerName,
  };

  /*
    A placeholder that resolved to nothing — an unnamed holiday, a schedule with
    no opening inside the lookahead — leaves the space it sat in behind. Closing
    that is the difference between "reply on ." and a sentence, and it is
    cheaper than making every admin write a template that reads correctly both
    with and without each value.

    The gap is closed where it is made, in the same pass, rather than by tidying
    the finished message afterwards. Collapsing `/[ \t]{2,}/` over the whole body
    was the shorter way to write it and it reflowed the admin's own text: an
    indented list or a column aligned with spaces came out flattened, on every
    send, with nothing in the editor to show that it had happened.
  */
  return body
    .replace(
      /([ \t]*)\{\{\s*([a-z_]+)\s*\}\}([ \t]*)([,.!؟?])?/gi,
      (match, before: string, name: string, after: string, punctuation?: string) => {
        const value = values[name.toLowerCase()];
        if (value === undefined) return match;
        if (value) return `${before}${value}${after}${punctuation ?? ''}`;

        // Nothing to interpolate. A gap between two words closes to a single
        // space; one sitting against punctuation, a line end, or another empty
        // placeholder closes completely.
        if (punctuation) return punctuation;
        return before && after ? ' ' : '';
      },
    )
    .trim();
}

/** The placeholders an admin can use, for the hint under the editor. */
export const PLACEHOLDERS = [
  {
    token: '{{next_opening}}',
    describes: 'when the office opens next, in the customer’s language',
  },
  { token: '{{holiday}}', describes: 'the name of the holiday, on a holiday' },
  { token: '{{ticket_number}}', describes: 'the ticket number' },
  { token: '{{customer_name}}', describes: 'the customer’s name, blank if we do not know it' },
] as const;
