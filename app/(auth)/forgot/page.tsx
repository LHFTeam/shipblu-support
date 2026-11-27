import Link from 'next/link';
import { ForgotForm } from './form';

export const dynamic = 'force-dynamic';

const LINK =
  'text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline';

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;

  if (sent) {
    return (
      <div className="text-sm">
        <p className="font-medium">Check your inbox.</p>
        {/* "If", and the same for every address: saying whether one signs in
            here would publish the staff list (`requestReset`). The last
            sentence is for the reader that conditional leaves waiting. */}
        <p className="mt-2 text-(--color-text-secondary)">
          If an account signs in with that address, we have sent it a link to choose a new password.
          The link works once, for one hour. If nothing arrives in a few minutes, check the spam
          folder or ask an administrator.
        </p>
        <p className="mt-4">
          <Link href="/login" className={LINK}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return <ForgotForm />;
}
