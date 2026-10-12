import { serviceNotice, type NoticeTone } from '@/lib/kb/notice';
import { t, type Locale } from '@/lib/kb/locale';
import { WarningIcon } from '@/components/icons';
import { Container } from './chrome';

/**
 * "Deliveries in Alexandria are running 24–48h behind schedule."
 *
 * Above the content on every help centre page rather than only on the front
 * one. A customer who followed a search result straight to an article about
 * delivery attempts is exactly the person a delay notice is for, and one that
 * only appears if you happen to arrive at the front door is not much of a
 * notice.
 *
 * Renders nothing until somebody has written a notice — see `lib/kb/notice.ts`
 * for where it comes from and why it is an environment variable for now.
 */
const TONE_CLASS: Record<NoticeTone, string> = {
  info: 'border-(--color-feedback-info-border) bg-(--color-feedback-info-bg) text-(--color-feedback-info-fg)',
  warning:
    'border-(--color-feedback-warning-border) bg-(--color-feedback-warning-bg) text-(--color-feedback-warning-fg)',
  danger:
    'border-(--color-feedback-danger-border) bg-(--color-feedback-danger-bg) text-(--color-feedback-danger-fg)',
};

export function ServiceNoticeBanner({ locale }: { locale: Locale }) {
  const notice = serviceNotice(locale);
  if (!notice) return null;

  return (
    /*
      `role="status"`, not `alert`. This is on screen when the page loads rather
      than arriving during it, so an assertive live region would interrupt a
      screen reader mid-sentence to announce something it is about to read out
      in order anyway.
    */
    <div role="status" className={`kb-noprint border-b ${TONE_CLASS[notice.tone]}`}>
      <Container className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 py-2.5 text-sm">
        <span className="flex items-center gap-2 font-bold">
          <WarningIcon size={16} className="shrink-0 self-center" />
          {t(locale, 'noticeLabel')}
        </span>

        {/*
          `lang` and `dir` because the body is not always in the page's language:
          a notice written in only one of the two is shown to everyone rather
          than silently withheld from the readers it does not cover, and an
          Arabic sentence inside an English page needs its own direction to lay
          out at all.
        */}
        <span lang={notice.lang} dir={notice.dir} className="text-(--color-text-secondary)">
          {notice.body}
        </span>

        {notice.href ? (
          <a
            href={notice.href}
            className="ms-auto font-bold whitespace-nowrap underline-offset-4 hover:underline"
          >
            {t(locale, 'noticeMore')}
          </a>
        ) : null}
      </Container>
    </div>
  );
}
