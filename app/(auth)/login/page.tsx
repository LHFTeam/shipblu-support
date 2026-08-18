import { redirect } from 'next/navigation';
import { needsBootstrap } from '@/lib/auth/guard';
import { getSessionAgent } from '@/lib/auth/session';
import { LoginForm } from './form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // A fresh deploy has no accounts at all; send the first visitor to setup
  // rather than to a form nobody can pass.
  if (await needsBootstrap()) redirect('/setup');
  if (await getSessionAgent()) redirect('/inbox');

  const { next } = await searchParams;

  return <LoginForm next={next ?? '/inbox'} />;
}
