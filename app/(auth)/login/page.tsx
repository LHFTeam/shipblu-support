import { redirect } from 'next/navigation';
import { Notice } from '@/components/ui';
import { needsBootstrap } from '@/lib/auth/guard';
import { HELP_CENTRE_SIGN_IN } from '@/lib/auth/next-path';
import { getSessionAgent } from '@/lib/auth/session';
import { LoginForm } from './form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; signedOut?: string; from?: string }>;
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

  const { next, signedOut, from } = await searchParams;

  return (
    <div className="flex flex-col gap-3.5">
      {/* Arriving at a login form you did not ask for reads as a bug, and the
          guess people make is that the system logged them out at random. Saying
          which rule did it — once, only when it did — is the difference between
          a setting and a fault. */}
      {signedOut ? (
        <Notice tone="info" icon>
          {signedOut === 'inactivity'
            ? 'You were signed out after a period of inactivity. Sign in to carry on.'
            : /* Everything that is not the browser's own countdown: the sweep,
                 a deactivation, a password change elsewhere. Naming inactivity
                 here would tell somebody whose access was just revoked
                 something untrue. */
              'Your session has ended. Sign in to carry on.'}
        </Notice>
      ) : null}
      {/* Sent here by the help centre's sign-in, on the help centre's own
          address, which serves no console and so could not keep the session
          (`signInWithPassword`). The password was right; asking for it again
          unexplained reads as a sign-in that failed. */}
      {from === HELP_CENTRE_SIGN_IN ? (
        <Notice tone="info" icon>
          The help centre’s address does not open the console. Sign in here, on the console’s own
          address, and keep this page for next time.
        </Notice>
      ) : null}
      <LoginForm next={next ?? '/inbox'} />
    </div>
  );
}
