import { redirect } from 'next/navigation';
import { needsBootstrap } from '@/lib/auth/guard';
import { SetupForm } from './form';

export const dynamic = 'force-dynamic';

/**
 * First-run admin creation.
 *
 * Available only while the instance has zero agents, so it closes permanently
 * the moment the first account exists. That makes a fresh deploy usable without
 * shell access or a seeded password, without leaving a standing back door.
 */
export default async function SetupPage() {
  if (!(await needsBootstrap())) redirect('/login');
  return <SetupForm />;
}
