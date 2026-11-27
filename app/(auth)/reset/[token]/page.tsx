import type { Metadata } from 'next';
import Link from 'next/link';
import { findLiveAgentReset } from '@/lib/auth/password-reset';
import { ResetForm } from './form';

export const dynamic = 'force-dynamic';

/**
 * The address of this page is the credential, so it is sent nowhere as a
 * referrer: not to the help centre the layout links to, and not to anything a
 * later change puts on the page.
 */
export const metadata: Metadata = { referrer: 'no-referrer' };

const LINK =
  'text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline';

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Read, never spent: a mail scanner opens every link before the person
  // does, and landing here must not cost them the one they were sent.
  const reset = await findLiveAgentReset(token, new Date());

  if (!reset) {
    return (
      <div className="text-sm">
        <p className="font-medium">This link is no longer valid.</p>
        <p className="mt-2 text-(--color-text-secondary)">
          It has expired or has already been used. Reset links work once, for one hour.
        </p>
        <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
          <Link href="/forgot" className={LINK}>
            Send a new link
          </Link>
          <Link href="/login" className={LINK}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return <ResetForm token={token} email={reset.email} />;
}
