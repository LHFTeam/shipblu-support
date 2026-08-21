import Link from 'next/link';
import type { ReactNode } from 'react';
import { type Locale } from '@/lib/kb/locale';
import { PageBody, Panel } from '../chrome';

/**
 * The frame every account page sits in — one narrow column, a heading and a
 * card. Shared so sign-in, registration and the two password pages cannot drift
 * apart visually, which on a page that asks for a password reads as a phishing
 * copy of the real one.
 *
 * No blue band here, unlike the knowledge-base pages. These are four short
 * forms, and a full-width coloured header above a 24rem column looks like the
 * page failed to load the rest of itself.
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
    <PageBody>
      <div className="mx-auto w-full max-w-sm">
        <h1 className="text-xl font-semibold text-[var(--kb-heading)]">{title}</h1>
        {intro ? <p className="mt-1.5 text-sm text-[var(--kb-muted)]">{intro}</p> : null}

        <Panel className="mt-6 p-6">{children}</Panel>

        {footer ? <div className="mt-4 text-sm text-[var(--kb-muted)]">{footer}</div> : null}
      </div>
    </PageBody>
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
    <Link
      href={`/${locale}/account/${path}`}
      className="text-[var(--kb-link)] underline underline-offset-4"
    >
      {children}
    </Link>
  );
}
