/**
 * Shapes the widget's three views pass between each other.
 *
 * Declared here rather than imported from `lib/widget/conversation.ts`, which
 * they mirror: that module opens a database connection at import, so a client
 * component naming its types would pull the driver into the browser bundle.
 */

export type Message = {
  id: string;
  from: 'visitor' | 'agent' | 'system';
  authorName: string | null;
  body: string;
  createdAt: string;
};

/** An article the widget can open in the panel. */
export type ArticleLink = {
  title: string;
  slug: string;
};

/** What the visitor is looking at. */
export type WidgetView = 'home' | 'article' | 'thread';
