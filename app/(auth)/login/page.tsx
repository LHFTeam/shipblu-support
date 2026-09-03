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
  // A fresh deploy has no accounts at all; send the first visitor to setup
  // rather than to a form nobody can pass.
  if (await needsBootstrap()) redirect('/setup');
  if (await getSessionAgent()) redirect('/inbox');

  const { next, signedOut } = await searchParams;

  return (
    <div className="flex flex-col gap-3">
      {/* Arriving at a login form you did not ask for reads as a bug, and the
          guess people make is that the system logged them out at random. Saying
          which rule did it — once, only when it did — is the difference between
          a setting and a fault. */}
      {signedOut === 'inactivity' ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
          You were signed out after a period of inactivity. Sign in to carry on.
        </p>
      ) : null}
      <LoginForm next={next ?? '/inbox'} />
    </div>
  );
}
