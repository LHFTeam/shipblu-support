import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationCategories,
  conversations,
  messages,
  ticketCategories,
  ticketRootCauses,
} from '@/db/schema';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';

/**
 * Reading categories back out.
 *
 * Labels always come from the registry through the join, never from the
 * `category_key` frozen on the assignment: that column is provenance — what was
 * assigned at the time — and rendering it would show an agent a name an admin
 * has since corrected.
 */

export type AssignedCategory = {
  categoryId: string;
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
export async function categoriesForConversation(
  conversationId: string,
): Promise<AssignedCategory[]> {
  const rows = await db
    .select({
      categoryId: conversationCategories.categoryId,
      key: ticketCategories.key,
      area: ticketCategories.area,
      labelEn: ticketCategories.labelEn,
      labelAr: ticketCategories.labelAr,
      source: conversationCategories.source,
      reviewState: conversationCategories.reviewState,
      confidence: conversationCategories.confidence,
      isPrimary: conversationCategories.isPrimary,
      ruleKey: conversationCategories.ruleKey,
      detectedInMessageId: conversationCategories.detectedInMessageId,
      firstSeenAt: conversationCategories.firstSeenAt,
    })
    .from(conversationCategories)
    .innerJoin(ticketCategories, eq(ticketCategories.id, conversationCategories.categoryId))
    .where(eq(conversationCategories.conversationId, conversationId))
    .orderBy(
      desc(conversationCategories.isPrimary),
      desc(conversationCategories.confidence),
      asc(ticketCategories.position),
    );

  return rows;
}

export type CategoryOption = {
  id: string;
  key: string;
  area: string;
  labelEn: string;
  labelAr: string;
  audience: 'merchant' | 'recipient' | 'any';
};

/**
 * The categories an agent may choose from.
 *
 * `meta.unclassified` is excluded: it is what the detector says when it could
 * not read a message, and a person choosing it by hand would be recording a
 * machine's failure as their own judgement.
 */
export async function categoryOptions(): Promise<CategoryOption[]> {
  return db
    .select({
      id: ticketCategories.id,
      key: ticketCategories.key,
      area: ticketCategories.area,
      labelEn: ticketCategories.labelEn,
      labelAr: ticketCategories.labelAr,
      audience: ticketCategories.audience,
    })
    .from(ticketCategories)
    .where(and(eq(ticketCategories.isActive, true), ne(ticketCategories.key, 'meta.unclassified')))
    .orderBy(asc(ticketCategories.position));
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
  categoryId: string;
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
 * **`channels` is a required argument, not a default.** It is how the caller
 * passes what the signed-in agent may see: this queue joins conversations, and a
 * default here would be a side door around `ticket.view.bot` for anybody holding
 * `admin.categories`.
 */
export async function reviewQueue(options: {
  visibleChannels: readonly ConversationChannel[];
  limit?: number;
}): Promise<ReviewRow[]> {
  if (options.visibleChannels.length === 0) return [];

  const rows = await db
    .select({
      conversationId: conversationCategories.conversationId,
      number: conversations.number,
      subject: conversations.subject,
      channel: conversations.channel,
      categoryId: conversationCategories.categoryId,
      key: ticketCategories.key,
      labelEn: ticketCategories.labelEn,
      confidence: conversationCategories.confidence,
      ruleKey: conversationCategories.ruleKey,
      firstSeenAt: conversationCategories.firstSeenAt,
      excerpt: messages.bodyText,
    })
    .from(conversationCategories)
    .innerJoin(ticketCategories, eq(ticketCategories.id, conversationCategories.categoryId))
    .innerJoin(conversations, eq(conversations.id, conversationCategories.conversationId))
    .leftJoin(messages, eq(messages.id, conversationCategories.detectedInMessageId))
    .where(
      and(
        eq(conversationCategories.reviewState, 'suggested'),
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
    .orderBy(desc(conversationCategories.confidence), desc(conversationCategories.firstSeenAt))
    .limit(options.limit ?? 50);

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
 * checked. Grouping by the stored key rather than by category is deliberate —
 * two rules can award the same category and only one of them be wrong.
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
