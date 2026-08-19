import { notFound } from 'next/navigation';
import { isLocale, t } from '@/lib/kb/locale';
import { AccountLink, AccountShell } from '../shell';
import { RegisterForm } from './form';

export const dynamic = 'force-dynamic';

export default async function PortalRegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <AccountShell
      title={t(locale, 'createAccountTitle')}
      intro={t(locale, 'createAccountIntro')}
      footer={
        <>
          {t(locale, 'haveAccount')}{' '}
          <AccountLink locale={locale} path="login">
            {t(locale, 'signIn')}
          </AccountLink>
        </>
      }
    >
      <RegisterForm locale={locale} />
    </AccountShell>
  );
}
