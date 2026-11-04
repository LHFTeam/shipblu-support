'use client';

import { useSyncExternalStore } from 'react';
import type { PlayableMedia } from '@/lib/attachments/preview';

/*
  Whether this browser plays a media type is only known in the browser, and a
  WhatsApp voice note is the case that varies: Ogg Opus plays on an iPhone from
  iOS 18.4, and before it a player shows a duration and then plays nothing. So
  a thread draws every media file as the link it always was on the server, and
  the player once the browser has been asked. `useSyncExternalStore` with a
  server snapshot is what lets the first client render match the server's, as
  `components/use-now.ts` does for the clock.

  One copy for the console's thread and the widget's: a probe-string or
  `canPlayType` fix landing in one and not the other would give the same iPhone
  a dead player on one surface and a link on the other.
*/

const subscribeToNothing = () => () => {};

/** False in the server's render and the hydrating one, true after: when `canPlay` may be asked. */
export const useOnClient = () =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

const verdicts = new Map<string, boolean>();

/** Whether this browser says it can play the type; only once `useOnClient` is true. */
export function canPlay(media: PlayableMedia): boolean {
  const key = `${media.kind} ${media.probe}`;
  let verdict = verdicts.get(key);
  if (verdict === undefined) {
    verdict = document.createElement(media.kind).canPlayType(media.probe) !== '';
    verdicts.set(key, verdict);
  }
  return verdict;
}
