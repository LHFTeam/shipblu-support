'use client';

import { chatWidget } from '../../chat';

/**
 * "Ask support about this shipment", which opens the chat with the parcel
 * already in the composer.
 *
 * A link with a click handler over it rather than a button, and the link is the
 * part that has to keep working: the snippet loads `async`, a visitor can reach
 * this within that moment, and an ad blocker or a corporate proxy may mean it
 * never arrives at all. So the `href` is the route this button had before the
 * chat existed — `/{locale}/forms`, which on an installation that has built a
 * form is a perfectly good place to land — and the handler takes over only once
 * `compose` is actually there to call. Nothing here is conditional on render, so
 * the server and the first client pass agree and the link is real in the markup.
 *
 * Modified clicks are left alone. Somebody opening this in a new tab is asking
 * for the page, and swallowing that to open a panel in the tab they left behind
 * is the kind of hijack that teaches people not to trust a link.
 */
export function AskSupport({
  href,
  prefill,
  children,
  className,
}: {
  href: string;
  /** The draft, built by `shipmentChatPrefill` on the server. */
  prefill: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const widget = chatWidget();
        if (!widget?.compose) return;

        event.preventDefault();
        widget.compose(prefill);
      }}
    >
      {children}
    </a>
  );
}
