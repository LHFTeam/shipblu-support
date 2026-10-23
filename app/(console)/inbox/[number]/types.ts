import type { AgentArticleHit } from '@/lib/kb/agent-search';

/**
 * Shapes the ticket page's client components share.
 *
 * A module of their own so that `composer.tsx` need not import `view.tsx`,
 * which renders the composer: that import made the two files a cycle.
 */

export type TemplateOption = {
  id: string;
  name: string;
  language: string;
  category: string;
  components: unknown[];
};

/**
 * What the knowledge panel needs, or null when the agent lacks `kb.view`.
 *
 * Passed as one object rather than two props so "this agent has no knowledge
 * panel" is a single null to check, in the same shape the sidebar's optional
 * sections use.
 */
export type KnowledgeContext = {
  suggestions: AgentArticleHit[];
  /** The customer's language, read off the script of what they last wrote. */
  locale: 'ar' | 'en';
};

/**
 * One of the requester's comments on a comment ticket, as the reply form offers
 * it to a private reply: the message's id, which is all the form posts and the
 * action re-reads (`lib/tickets/reply-comment.ts`), and what the agent needs to
 * tell the comments apart.
 */
export type RequesterCommentOption = {
  id: string;
  text: string;
  at: Date;
};
