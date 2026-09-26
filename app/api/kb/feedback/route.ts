import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { kbArticleFeedback, kbArticles } from '@/db/schema';
import { readJsonBody } from '@/lib/http/json-body';
import { allow, clientIp } from '@/lib/http/rate-limit';

export const dynamic = 'force-dynamic';

/** Feedback is a considered act, so the ceiling is much lower than for views. */
const LIMIT = 10;
const WINDOW_MS = 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COMMENT = 2000;

/** Any object; each field is checked below, where each refusal is decided. */
const feedbackBody = z.object({
  articleId: z.unknown().optional(),
  wasHelpful: z.unknown().optional(),
  comment: z.unknown().optional(),
});

export async function POST(request: Request) {
  if (!allow(`kb-feedback:${clientIp(request)}`, LIMIT, WINDOW_MS)) {
    return new NextResponse(null, { status: 429 });
  }

  const body = await readJsonBody(request, feedbackBody);
  if (!body) return new NextResponse(null, { status: 400 });

  const { articleId, wasHelpful } = body;
  if (typeof articleId !== 'string' || !UUID.test(articleId)) {
    return new NextResponse(null, { status: 400 });
  }
  if (typeof wasHelpful !== 'boolean') {
    return new NextResponse(null, { status: 400 });
  }

  // Free text from an anonymous internet visitor. Truncated rather than
  // rejected — someone who wrote too much still told us something — and only
  // ever rendered in the console, which escapes it.
  const comment =
    typeof body.comment === 'string' && body.comment.trim()
      ? body.comment.trim().slice(0, MAX_COMMENT)
      : null;

  // Checked before inserting rather than catching the foreign-key violation:
  // an id for a deleted article is an ordinary race (someone had the page open
  // when it was unpublished), and a 204 is the honest answer to it.
  const exists = await db
    .select({ id: kbArticles.id })
    .from(kbArticles)
    .where(eq(kbArticles.id, articleId))
    .limit(1);

  if (exists.length === 0) return new NextResponse(null, { status: 204 });

  // Written together so the denormalised counters on the article can never
  // disagree with the rows they summarise.
  await db.transaction(async (tx) => {
    await tx.insert(kbArticleFeedback).values({ articleId, wasHelpful, comment });

    await tx
      .update(kbArticles)
      .set(
        wasHelpful
          ? { helpfulCount: sql`${kbArticles.helpfulCount} + 1` }
          : { unhelpfulCount: sql`${kbArticles.unhelpfulCount} + 1` },
      )
      .where(eq(kbArticles.id, articleId));
  });

  return new NextResponse(null, { status: 204 });
}
