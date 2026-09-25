import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { databaseProbe } from '@/db/client';
import {
  isRenderProbeRequest,
  RENDER_PROBE_HEADER,
  RENDER_PROBE_MARKER,
  within,
} from '@/lib/health/probe';

export const dynamic = 'force-dynamic';

// Never indexed: this is instrumentation, not a page anyone should land on.
export const metadata = { robots: { index: false, follow: false } };

/**
 * The page `/api/health` renders to prove that rendering works.
 *
 * It has to be a *page*. A route handler answering is not evidence that a
 * Server Component can render: on 2026-09-08 `/api/health` could have gone on
 * returning 200 while every console page hung, and a 200 is not evidence a page
 * renders anyway (AGENTS.md, "Verify, do not infer"). Render restarts an
 * instance only when its check fails, so the check has to exercise the path
 * that fails.
 *
 * One statement, no tables of ours: the question is "can a render reach the
 * database", not "is the data right". It uses the same cancellable probe and
 * the same budget as the health route, so a saturated pool fails this page in
 * five seconds rather than leaving one more queued query behind per poll — the
 * health check aborting its fetch does not stop the render on this side.
 */
export default async function ProbePage() {
  const requestHeaders = await headers();
  if (!isRenderProbeRequest(requestHeaders.get(RENDER_PROBE_HEADER))) notFound();

  const probe = databaseProbe();
  await within('select 1 from a render', probe.done, probe.abandon);

  return <p>{RENDER_PROBE_MARKER}</p>;
}
