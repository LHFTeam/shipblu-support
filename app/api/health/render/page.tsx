import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { acceptsProbe } from '@/lib/health/readiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = { robots: { index: false, follow: false } };

/** A real Server Component, not a route handler with another healthy pool. */
export default async function ReadinessRender() {
  const requestHeaders = await headers();
  const nonce = requestHeaders.get('x-readiness-nonce');
  if (
    !acceptsProbe(requestHeaders.get('x-readiness-token')) ||
    !nonce ||
    !/^[a-f0-9]{32}$/.test(nonce)
  ) {
    notFound();
  }
  // Exercise the application's schema/role as well as a database round trip.
  // A fresh installation with no agents must be ready for /setup too.
  await db.execute(sql`select id from agents limit 1`);
  return <output data-readiness={nonce}>ready</output>;
}
