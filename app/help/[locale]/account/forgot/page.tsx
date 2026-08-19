import { notFound } from 'next/navigation';
import { isLocale, t } from '@/lib/kb/locale';
import { AccountLink, AccountShell } from '../shell';
import { ForgotForm } from './form';

export const dynamic = 'force-dynamic';

export default async function PortalForgotPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <AccountShell
      title={t(locale, 'forgotTitle')}
      intro={t(locale, 'forgotIntro')}
      footer={
        <AccountLink locale={locale} path="login">
          {t(locale, 'signIn')}
        </AccountLink>
      }
    >
      <ForgotForm locale={locale} />
    </AccountShell>
  );
}
