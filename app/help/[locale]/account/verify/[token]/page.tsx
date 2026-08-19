import { notFound } from 'next/navigation';
import { isLocale, t } from '@/lib/kb/locale';
import { redeemVerification } from '@/lib/portal/accounts';
import { AccountLink, AccountShell } from '../../shell';

export const dynamic = 'force-dynamic';

/**
 * Confirms an email address.
 *
 * A page rather than a route handler that redirects, because the outcome is
 * something the customer needs to read: a link that quietly bounced them to the
 * sign-in form would leave them guessing whether it worked.
 */
export default async function PortalVerifyPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  if (!isLocale(locale)) notFound();

  const result = await redeemVerification(decodeURIComponent(token));

  if (!result.ok) {
    return (
      <AccountShell
        title={t(locale, 'verifyInvalidTitle')}
        footer={
          <AccountLink locale={locale} path="register">
            {t(locale, 'createAccount')}
          </AccountLink>
        }
      >
        <p className="text-sm opacity-70">{t(locale, 'verifyInvalid')}</p>
      </AccountShell>
    );
  }

  return (
    <AccountShell
      title={t(locale, 'verifySuccessTitle')}
      footer={
        <AccountLink locale={locale} path="login">
          {t(locale, 'signIn')}
        </AccountLink>
      }
    >
      <p className="text-sm opacity-70">{t(locale, 'verifySuccess')}</p>
    </AccountShell>
  );
}
