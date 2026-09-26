/**
 * Which of the widget's three screens opens first.
 *
 * Pure and separate from the component because it is the one piece of the view
 * state that is a *rule* rather than a reaction, and because getting it wrong is
 * invisible in review: landing a visitor mid-conversation on the FAQ list buries
 * the reply they came back to read, and it is the returning visitor — the one
 * who is hardest to reproduce by hand — who hits it.
 */

export type { WidgetView } from './types';

/**
 * Home unless there is a conversation to come back to.
 *
 * Keyed on messages rather than on the token, because a token only means this
 * browser has opened the widget before. A visitor who read an FAQ last week has
 * one and has said nothing; they get the home screen, same as a stranger. A
 * conversation with messages in it is the only thing that outranks the FAQs.
 */
export function initialView({ messageCount }: { messageCount: number }): 'home' | 'thread' {
  return messageCount > 0 ? 'thread' : 'home';
}
