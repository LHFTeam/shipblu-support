import Link from 'next/link';
import type { ReactNode } from 'react';
import { type Locale } from '@/lib/kb/locale';

/**
 * The frame every account page sits in — one narrow column, a heading and a
 * card. Shared so sign-in, registration and the two password pages cannot drift
 * apart visually, which on a page that asks for a password reads as a phishing
 * copy of the real one.
 */
export function AccountShell({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="text-xl font-semibold">{title}</h1>
      {intro ? <p className="mt-1 text-sm opacity-70">{intro}</p> : null}

      <div className="mt-6 rounded-lg border border-[var(--border)] p-6">{children}</div>

      {footer ? <div className="mt-4 text-sm opacity-70">{footer}</div> : null}
    </div>
  );
}

export function AccountLink({
  locale,
  path,
  children,
}: {
  locale: Locale;
  path: string;
  children: ReactNode;
}) {
  return (
    <Link href={`/${locale}/account/${path}`} className="underline underline-offset-4">
      {children}
    </Link>
  );
}
