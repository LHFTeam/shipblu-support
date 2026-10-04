'use client';

import { HelpFailed } from '../failed';

/**
 * A help-centre page that failed, shown inside the help centre.
 *
 * Without this a page error fell through to `app/global-error.tsx`, which
 * replaces the root layout, so the help layout above went with it — and the
 * chat with the layout, because `ChatWidget` takes the chat down when the help
 * layout goes. A customer mid-conversation lost the panel and whatever they had
 * typed into it to a database hiccup on an unrelated page. Caught here, the
 * header, the footer and the chat all stay, and only the page is replaced.
 *
 * This boundary cannot catch the `[locale]` layout itself, which is above it in
 * the same segment; `app/help/error.tsx` does.
 */
export default function KbPageError({ retry }: { retry: () => void }) {
  return <HelpFailed retry={retry} />;
}
