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
