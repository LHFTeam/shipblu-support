import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationSubcategories,
  conversations,
  messages,
  ticketSubcategories,
  ticketRootCauses,
} from '@/db/schema';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { UNCLASSIFIED_KEY } from './taxonomy';

/**
 * Reading subcategories back out.
 *
 * Labels always come from the registry through the join, never from the
 * `category_key` frozen on the assignment: that column is provenance — what was
 * assigned at the time — and rendering it would show an agent a name an admin
 * has since corrected.
 */

export type AssignedSubcategory = {
  subcategoryId: string;
  key: string;
  area: string;
  labelEn: string;
  labelAr: string;
  source: 'detected' | 'manual' | 'platform';
  reviewState: 'auto' | 'suggested' | 'confirmed' | 'rejected';
  confidence: number;
  isPrimary: boolean;
  ruleKey: string | null;
  detectedInMessageId: string | null;
  firstSeenAt: Date;
};

/**
 * What this ticket is filed under.
 *
 * Rejected rows are included, because the sidebar has to be able to say "an
 * agent threw this one out" — a rejected row that simply vanished would invite
 * the next agent to add it back by hand, and then nobody would know the rules
 * had been wrong about it.
 */
export async function subcategoriesForConversation(
  conversationId: string,
): Promise<AssignedSubcategory[]> {
  const rows = await db
    .select({
      subcategoryId: conversationSubcategories.subcategoryId,
      key: ticketSubcategories.key,
      area: ticketSubcategories.area,
      labelEn: ticketSubcategories.labelEn,
      labelAr: ticketSubcategories.labelAr,
      source: conversationSubcategories.source,
      reviewState: conversationSubcategories.reviewState,
      confidence: conversationSubcategories.confidence,
      isPrimary: conversationSubcategories.isPrimary,
      ruleKey: conversationSubcategories.ruleKey,
      detectedInMessageId: conversationSubcategories.detectedInMessageId,
      firstSeenAt: conversationSubcategories.firstSeenAt,
    })
    .from(conversationSubcategories)
    .innerJoin(
      ticketSubcategories,
      eq(ticketSubcategories.id, conversationSubcategories.subcategoryId),
    )
    .where(eq(conversationSubcategories.conversationId, conversationId))
    .orderBy(
      desc(conversationSubcategories.isPrimary),
      desc(conversationSubcategories.confidence),
      asc(ticketSubcategories.position),
    );

  return rows;
}

export type SubcategoryOption = {
  id: string;
  key: string;
  area: string;
  labelEn: string;
  labelAr: string;
  audience: 'merchant' | 'recipient' | 'any';
};

/**
 * The subcategories an agent may choose from.
 *
 * `meta.unclassified` is excluded: it is what the detector says when it could
 * not read a message, and a person choosing it by hand would be recording a
 * machine's failure as their own judgement.
 */
export async function subcategoryOptions(): Promise<SubcategoryOption[]> {
  return db
    .select({
      id: ticketSubcategories.id,
      key: ticketSubcategories.key,
      area: ticketSubcategories.area,
      labelEn: ticketSubcategories.labelEn,
      labelAr: ticketSubcategories.labelAr,
      audience: ticketSubcategories.audience,
    })
    .from(ticketSubcategories)
    .where(
      and(eq(ticketSubcategories.isActive, true), ne(ticketSubcategories.key, 'meta.unclassified')),
    )
    .orderBy(asc(ticketSubcategories.position));
}

export type RootCauseOption = {
  id: string;
  key: string;
  labelEn: string;
  labelAr: string;
  owner: 'courier' | 'hub' | 'merchant' | 'recipient' | 'platform' | 'external' | 'none';
};

export async function rootCauseOptions(): Promise<RootCauseOption[]> {
  return db
    .select({
      id: ticketRootCauses.id,
      key: ticketRootCauses.key,
      labelEn: ticketRootCauses.labelEn,
      labelAr: ticketRootCauses.labelAr,
      owner: ticketRootCauses.owner,
    })
    .from(ticketRootCauses)
    .where(eq(ticketRootCauses.isActive, true))
    .orderBy(asc(ticketRootCauses.position));
}

export type ReviewRow = {
  conversationId: string;
  number: number;
  subject: string | null;
  channel: string;
  subcategoryId: string;
  key: string;
  labelEn: string;
  confidence: number;
  ruleKey: string | null;
  firstSeenAt: Date;
  /** The message that earned it — a suggestion cannot be judged without it. */
  excerpt: string | null;
};

/**
 * Everything waiting on one click.
 *
 * Ordered by confidence descending, so the queue opens on the suggestions most
 * likely to be right: those are the cheapest to confirm, and clearing them
 * fastest is what keeps the queue from becoming the thing nobody opens.
 *
 * **`meta.unclassified` is excluded, and gets `unclassifiedQueue()` instead.**
 * It carries confidence 0 by definition, so under this ordering it sorted below
 * every real suggestion and fell off the end of the page the moment fifty were
 * waiting — which is precisely when the under-detection it represents matters
 * most. It is also a different question: a suggestion asks "is this right?",
 * and an unclassified message asks "what should this have matched?". One list
 * with one pair of buttons cannot ask both.
 *
 * **`channels` is a required argument, not a default.** It is how the caller
 * passes what the signed-in agent may see: this queue joins conversations, and a
 * default here would be a side door around `ticket.view.bot` for anybody holding
 * `admin.subcategories`.
 */
export async function reviewQueue(options: {
  visibleChannels: readonly ConversationChannel[];
  limit?: number;
}): Promise<ReviewRow[]> {
  if (options.visibleChannels.length === 0) return [];

  const rows = await db
    .select({
      conversationId: conversationSubcategories.conversationId,
      number: conversations.number,
      subject: conversations.subject,
      channel: conversations.channel,
      subcategoryId: conversationSubcategories.subcategoryId,
      key: ticketSubcategories.key,
      labelEn: ticketSubcategories.labelEn,
      confidence: conversationSubcategories.confidence,
      ruleKey: conversationSubcategories.ruleKey,
      firstSeenAt: conversationSubcategories.firstSeenAt,
      excerpt: messages.bodyText,
    })
    .from(conversationSubcategories)
    .innerJoin(
      ticketSubcategories,
      eq(ticketSubcategories.id, conversationSubcategories.subcategoryId),
    )
    .innerJoin(conversations, eq(conversations.id, conversationSubcategories.conversationId))
    .leftJoin(messages, eq(messages.id, conversationSubcategories.detectedInMessageId))
    .where(
      and(
        eq(conversationSubcategories.reviewState, 'suggested'),
        ne(conversationSubcategories.subcategoryKey, UNCLASSIFIED_KEY),
        // `inArray`, never a hand-written `= any(...)`. Drizzle interpolates a
        // JS array as separate bind parameters, so `any($2, $3)` reaches
        // Postgres as a row constructor and it answers `op ANY/ALL (array)
        // requires array on right side`. That version type-checked, linted
        // clean, and died on its first real execution — the exact shape of bug
        // AGENTS.md records `backfill_meta_profiles` shipping green with.
        inArray(conversations.channel, options.visibleChannels),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(
      desc(conversationSubcategories.confidence),
      desc(conversationSubcategories.firstSeenAt),
    )
    .limit(options.limit ?? 50);

  return rows.map((row) => ({
    ...row,
    excerpt: row.excerpt ? row.excerpt.slice(0, 240) : null,
  }));
}

export type UnclassifiedRow = {
  conversationId: string;
  number: number;
  channel: string;
  firstSeenAt: Date;
  /** What the detector could not read. Without it there is nothing to act on. */
  excerpt: string | null;
};

/**
 * Messages no rule matched, newest first.
 *
 * Its own query and its own section rather than a row in the main queue, for
 * two reasons. It sorts on time because there is no evidence to sort on — the
 * fallback is confidence 0 — and the useful ones are the recent ones, since
 * this list is read to find what the lexicon is missing *now*. And the action
 * it invites is different: nobody confirms that a message was unreadable; they
 * read it and go and write a rule.
 *
 * Takes `visibleChannels` for the same reason `reviewQueue` does — it joins
 * `conversations`, so a default would be a side door around `ticket.view.bot`.
 */
export async function unclassifiedQueue(options: {
  visibleChannels: readonly ConversationChannel[];
  limit?: number;
}): Promise<UnclassifiedRow[]> {
  if (options.visibleChannels.length === 0) return [];

  const rows = await db
    .select({
      conversationId: conversationSubcategories.conversationId,
      number: conversations.number,
      channel: conversations.channel,
      firstSeenAt: conversationSubcategories.firstSeenAt,
      excerpt: messages.bodyText,
    })
    .from(conversationSubcategories)
    .innerJoin(conversations, eq(conversations.id, conversationSubcategories.conversationId))
    .leftJoin(messages, eq(messages.id, conversationSubcategories.detectedInMessageId))
    .where(
      and(
        eq(conversationSubcategories.subcategoryKey, UNCLASSIFIED_KEY),
        eq(conversationSubcategories.reviewState, 'suggested'),
        inArray(conversations.channel, options.visibleChannels),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(desc(conversationSubcategories.firstSeenAt))
    .limit(options.limit ?? 25);

  return rows.map((row) => ({
    ...row,
    excerpt: row.excerpt ? row.excerpt.slice(0, 240) : null,
  }));
}

export type RuleScore = {
  ruleKey: string;
  agreed: number;
  rejected: number;
  unreviewed: number;
};

/**
 * How each rule is doing, which is the whole tuning surface.
 *
 * Needs no extra machinery because the assignment row already carries the rule
 * that fired and survives being rejected: a rule with a high `rejected` count is
 * one to narrow, and one with nothing but `unreviewed` is one nobody has
 * checked. Grouping by the stored key rather than by subcategory is
 * deliberate — two rules can award the same subcategory and only one of them
 * be wrong.
 */
export async function ruleScores(): Promise<RuleScore[]> {
  const rows = await db.execute<{
    rule_key: string;
    agreed: number;
    rejected: number;
    unreviewed: number;
  }>(sql`
    select rule_key,
           count(*) filter (where review_state = 'confirmed')::int as agreed,
           count(*) filter (where review_state = 'rejected')::int  as rejected,
           count(*) filter (where review_state in ('auto', 'suggested'))::int as unreviewed
    from conversation_categories
    where rule_key is not null
    group by rule_key
    order by count(*) filter (where review_state = 'rejected') desc, rule_key
  `);

  return rows.map((row) => ({
    ruleKey: row.rule_key,
    agreed: row.agreed,
    rejected: row.rejected,
    unreviewed: row.unreviewed,
  }));
}
