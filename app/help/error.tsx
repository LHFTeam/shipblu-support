'use client';

import { useParams } from 'next/navigation';
import { DEFAULT_LOCALE, direction, isLocale } from '@/lib/kb/locale';
import { lato, tajawal } from './[locale]/fonts';
import { HelpFailed } from './failed';

/**
 * The `[locale]` layout itself failed, caught below the layout that holds the
 * chat.
 *
 * `[locale]/error.tsx` catches pages but not the layout in its own segment, and
 * that layout reads the database: `AccountNav` looks up a signed-in customer
 * whenever their cookie is set, on every language switch and every re-render a
 * server action causes. Without a boundary here, that failure reached
 * `app/global-error.tsx`, which replaces the root layout and so takes the help
 * layout — and with it the chat — away from a customer in the middle of a
 * conversation.
 *
 * Below `app/help/layout.tsx`, so the chat survives this one too. It renders
 * where the `[locale]` layout would have, which means it brings that layout's
 * shell with it: the direction, the language, and the palette and typefaces
 * `.kb-shell` scopes. There is no header or footer to reuse, because they are
 * what failed.
 */
export default function HelpLayoutError({ retry }: { retry: () => void }) {
  const params = useParams<{ locale?: string }>();
  const locale = isLocale(params?.locale) ? params.locale : DEFAULT_LOCALE;

  return (
    <div
      dir={direction(locale)}
      lang={locale}
      className={`kb-shell ${lato.variable} ${tajawal.variable} flex min-h-dvh flex-col antialiased`}
    >
      <main className="flex-1">
        <HelpFailed retry={retry} />
      </main>
    </div>
  );
}
