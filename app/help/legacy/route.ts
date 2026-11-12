import { NextResponse } from 'next/server';
import { legacyPathOf } from '@/lib/kb/legacy-path';
import { resolveLegacyPath } from '@/lib/kb/legacy-resolve';
import { redirectTo } from '@/lib/http/redirect';

export const dynamic = 'force-dynamic';

/**
 * Resolves a Freshdesk URL to its new home.
 *
 * The proxy does not do this itself — it stays out of the database, for the
 * reason its header gives — so it rewrites here, and `resolveLegacyPath` does
 * the lookup.
 */
export async function GET(request: Request) {
  // The proxy's header, or `?path=` on a direct call. Never the query alone:
  // through the proxy this handler is handed the URL as it arrived, which has
  // none (`lib/kb/legacy-path.ts`, PROJECT-STATE §6.115).
  const answer = await resolveLegacyPath(legacyPathOf(request));

  // 301 wherever the answer is the article or category the URL names: these
  // URLs are never coming back, and a permanent redirect is what transfers the
  // old page's search ranking to the new one. 302 while another translation
  // stands in for one closed for now (`LegacyAnswer`).
  //
  // That permanence is also why the relative `Location` matters more here than
  // anywhere else: a browser caches a 301 indefinitely, so the internal listen
  // address `new URL(to, request.url)` used to produce would have been
  // remembered per visitor rather than merely failing once.
  if (answer) return redirectTo(answer.to, answer.permanent ? 301 : 302);

  // Genuinely unknown. A 404 here is correct — redirecting every unmatched URL
  // to the home page is a well-known way to make a site unsearchable.
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}
