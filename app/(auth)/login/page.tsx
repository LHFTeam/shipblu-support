import { redirect } from 'next/navigation';
import { needsBootstrap } from '@/lib/auth/guard';
import { getSessionAgent } from '@/lib/auth/session';
import { LoginForm } from './form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; signedOut?: string }>;
}) {
  // The session first, because it is the cheaper question: `getSessionAgent()`
  // returns without touching the database when there is no cookie, while
  // `needsBootstrap()` always counts rows on a cold latch. Asking in the other
  // order made a signed-out visitor wait on a pool slot to be told to sign in,
  // which is where one of these spent 390 seconds during the freeze (§62).
  if (await getSessionAgent()) redirect('/inbox');

  // A fresh deploy has no accounts at all; send the first visitor to setup
  // rather than to a form nobody can pass.
  if (await needsBootstrap()) redirect('/setup');

  const { next, signedOut } = await searchParams;

  return (
    <div className="flex flex-col gap-3">
      {/* Arriving at a login form you did not ask for reads as a bug, and the
          guess people make is that the system logged them out at random. Saying
          which rule did it — once, only when it did — is the difference between
          a setting and a fault. */}
      {signedOut ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
          {signedOut === 'inactivity'
            ? 'You were signed out after a period of inactivity. Sign in to carry on.'
            : /* Everything that is not the browser's own countdown: the sweep,
                 a deactivation, a password change elsewhere. Naming inactivity
                 here would tell somebody whose access was just revoked
                 something untrue. */
              'Your session has ended. Sign in to carry on.'}
        </p>
      ) : null}
      <LoginForm next={next ?? '/inbox'} />
    </div>
  );
}
