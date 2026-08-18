import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { invites } from '@/db/schema';
import { hashToken } from '@/lib/auth/tokens';
import { InviteForm } from './form';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const rows = await db
    .select({ email: invites.email, name: invites.name })
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const invite = rows[0];

  if (!invite) {
    return (
      <div className="rounded-lg border border-[var(--border)] p-6 text-sm">
        <p className="font-medium">This invite is no longer valid.</p>
        <p className="mt-2 opacity-70">
          It has expired or has already been used. Ask an administrator to send a new one.
        </p>
      </div>
    );
  }

  return <InviteForm token={token} email={invite.email} name={invite.name} />;
}
