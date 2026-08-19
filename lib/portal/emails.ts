import type { Locale } from '@/lib/kb/locale';
import { publicBaseUrl } from '@/lib/kb/site';

/**
 * The two emails the portal sends.
 *
 * Written out per language rather than assembled from fragments: these are the
 * only messages a customer receives that are not a reply from a person, and a
 * sentence stitched together from four translated pieces reads like a machine
 * in Arabic even when every piece is correct.
 *
 * Links are built against the help-centre hostname, not APP_URL: a customer
 * clicking through to the Render service URL would land on a hostname that is
 * not the one they trust and, once the custom domain is live, not the one the
 * session cookie was set on.
 */

export type PortalEmail = { subject: string; textBody: string; htmlBody: string };

function accountUrl(locale: Locale, path: string, token: string): string {
  return `${publicBaseUrl()}/${locale}/account/${path}/${encodeURIComponent(token)}`;
}

/** Minimal HTML: a paragraph, a link, a note. Every client renders it the same. */
function wrap(lines: string[], locale: Locale): string {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return [
    `<div dir="${dir}" lang="${locale}" style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#111">`,
    ...lines,
    '</div>',
  ].join('\n');
}

export function verificationEmail(locale: Locale, token: string): PortalEmail {
  const url = accountUrl(locale, 'verify', token);

  if (locale === 'ar') {
    return {
      subject: 'أكّد بريدك الإلكتروني — دعم شيب بلو',
      textBody: [
        'مرحبًا،',
        '',
        'لتفعيل حسابك على مركز مساعدة شيب بلو، افتح الرابط التالي:',
        url,
        '',
        'الرابط صالح لمدة ٢٤ ساعة.',
        'إذا لم تطلب هذا الحساب فتجاهل هذه الرسالة — لن يُفعَّل شيء بدون فتح الرابط.',
        '',
        'دعم شيب بلو',
      ].join('\n'),
      htmlBody: wrap(
        [
          '<p>مرحبًا،</p>',
          '<p>لتفعيل حسابك على مركز مساعدة شيب بلو، افتح الرابط التالي:</p>',
          `<p><a href="${url}">تأكيد البريد الإلكتروني</a></p>`,
          '<p style="color:#666;font-size:13px">الرابط صالح لمدة ٢٤ ساعة. إذا لم تطلب هذا الحساب فتجاهل هذه الرسالة — لن يُفعَّل شيء بدون فتح الرابط.</p>',
          '<p>دعم شيب بلو</p>',
        ],
        locale,
      ),
    };
  }

  return {
    subject: 'Confirm your email — ShipBlu Support',
    textBody: [
      'Hello,',
      '',
      'To finish setting up your ShipBlu help centre account, open this link:',
      url,
      '',
      'The link is valid for 24 hours.',
      'If you did not ask for an account, ignore this email — nothing is activated until the link is opened.',
      '',
      'ShipBlu Support',
    ].join('\n'),
    htmlBody: wrap(
      [
        '<p>Hello,</p>',
        '<p>To finish setting up your ShipBlu help centre account, open this link:</p>',
        `<p><a href="${url}">Confirm my email</a></p>`,
        '<p style="color:#666;font-size:13px">The link is valid for 24 hours. If you did not ask for an account, ignore this email — nothing is activated until the link is opened.</p>',
        '<p>ShipBlu Support</p>',
      ],
      locale,
    ),
  };
}

export function passwordResetEmail(locale: Locale, token: string): PortalEmail {
  const url = accountUrl(locale, 'reset', token);

  if (locale === 'ar') {
    return {
      subject: 'إعادة تعيين كلمة المرور — دعم شيب بلو',
      textBody: [
        'مرحبًا،',
        '',
        'لتعيين كلمة مرور جديدة لحسابك على مركز مساعدة شيب بلو، افتح الرابط التالي:',
        url,
        '',
        'الرابط صالح لمدة ساعة واحدة ويعمل مرة واحدة فقط.',
        'إذا لم تطلب ذلك فتجاهل هذه الرسالة — كلمة مرورك الحالية لم تتغير.',
        '',
        'دعم شيب بلو',
      ].join('\n'),
      htmlBody: wrap(
        [
          '<p>مرحبًا،</p>',
          '<p>لتعيين كلمة مرور جديدة لحسابك على مركز مساعدة شيب بلو، افتح الرابط التالي:</p>',
          `<p><a href="${url}">تعيين كلمة مرور جديدة</a></p>`,
          '<p style="color:#666;font-size:13px">الرابط صالح لمدة ساعة واحدة ويعمل مرة واحدة فقط. إذا لم تطلب ذلك فتجاهل هذه الرسالة — كلمة مرورك الحالية لم تتغير.</p>',
          '<p>دعم شيب بلو</p>',
        ],
        locale,
      ),
    };
  }

  return {
    subject: 'Reset your password — ShipBlu Support',
    textBody: [
      'Hello,',
      '',
      'To set a new password for your ShipBlu help centre account, open this link:',
      url,
      '',
      'The link is valid for one hour and works once.',
      'If you did not ask for this, ignore this email — your current password is unchanged.',
      '',
      'ShipBlu Support',
    ].join('\n'),
    htmlBody: wrap(
      [
        '<p>Hello,</p>',
        '<p>To set a new password for your ShipBlu help centre account, open this link:</p>',
        `<p><a href="${url}">Set a new password</a></p>`,
        '<p style="color:#666;font-size:13px">The link is valid for one hour and works once. If you did not ask for this, ignore this email — your current password is unchanged.</p>',
        '<p>ShipBlu Support</p>',
      ],
      locale,
    ),
  };
}
