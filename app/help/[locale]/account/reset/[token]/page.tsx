import { notFound } from 'next/navigation';
import { isLocale, t } from '@/lib/kb/locale';
import { resetTokenIsLive } from '@/lib/portal/accounts';
import { AccountLink, AccountShell } from '../../shell';
import { ResetForm } from './form';

export const dynamic = 'force-dynamic';

export default async function PortalResetPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token: rawToken } = await params;
  if (!isLocale(locale)) notFound();

  // Route params arrive percent-encoded; the token is base64url so this is
  // usually a no-op, but decoding is what makes it a no-op rather than a
  // near-miss that fails to match the stored hash.
  const token = decodeURIComponent(rawToken);

  // Checked without spending it, so landing on the page does not consume the
  // one link the customer has.
  if (!(await resetTokenIsLive(token))) {
    return (
      <AccountShell
        title={t(locale, 'resetInvalidTitle')}
        footer={
          <AccountLink locale={locale} path="forgot">
            {t(locale, 'forgotPassword')}
          </AccountLink>
        }
      >
        <p className="text-sm opacity-70">{t(locale, 'resetInvalid')}</p>
      </AccountShell>
    );
  }

  return (
    <AccountShell title={t(locale, 'resetTitle')}>
      <ResetForm locale={locale} token={token} />
    </AccountShell>
  );
}
