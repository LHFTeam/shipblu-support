/**
 * Shapes the widget's three views pass between each other.
 *
 * Declared here rather than imported from `lib/widget/conversation.ts`, which
 * they mirror: that module imports the database client, so a client component
 * naming its types would pull the driver into the browser bundle.
 */

export type Message = {
  id: string;
  from: 'visitor' | 'agent' | 'system';
  authorName: string | null;
  body: string;
  createdAt: string;
  /** Set on the message that carries a satisfaction survey, which the thread draws as a card. */
  survey: WidgetSurvey | null;
  /**
   * The files on the message, in the order they were attached. A message sent
   * with files and no words has an empty `body`: the words stored for it are a
   * stand-in for the inbox card (`isMediaStandIn`), and the files are drawn in
   * their place. Absent from a payload served before files existed, so a reader
   * treats a missing list as an empty one.
   */
  attachments?: WidgetAttachment[];
};

/**
 * A file on a widget message, as the thread draws it.
 *
 * `contentType` is the server's reading of the bytes, never the browser's label
 * (`lib/widget/sniff.ts`), so the thread can decide on it. `url` is a link
 * signed for this one file (`lib/widget/file-links.ts`), never one carrying the
 * visitor's token; null on the visitor's own message before the server has
 * answered, which has no stored copy to fetch yet.
 */
export type WidgetAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  url: string | null;
};

/**
 * A satisfaction survey as the widget's card needs it: resolved on the
 * server from the rule the survey went out with, as that rule reads now, so
 * the card holds no wording logic of its own. It carries no token, and the card needs none: the
 * visitor's session is what answers it (`/api/widget/csat`). The message's
 * `body` still holds the survey's link, which is the visitor's own.
 */
export type WidgetSurvey = {
  id: string;
  /** The answer, once there is one. */
  rating: number | null;
  /** Superseded by a newer survey and never answered, so drawn closed. */
  expired: boolean;
  /** What it went out in, which can differ from the widget's own language. */
  locale: 'ar' | 'en';
  intro: string;
  question: string;
  /** The five ratings, worst first. */
  labels: [string, string, string, string, string];
  commentPrompt: string;
  button: string;
  thanks: string;
};

/** An article the widget can open in the panel. */
export type ArticleLink = {
  title: string;
  slug: string;
};

/** What the visitor is looking at. */
export type WidgetView = 'home' | 'article' | 'thread';
