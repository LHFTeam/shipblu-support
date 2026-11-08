import { getSessionAgent } from '@/lib/auth/session';
import { shownTo } from './images';
import { kbViewer } from './viewer';

/**
 * Whether the request may see a knowledge-base picture that no stranger may:
 * one in an internal article, a signed-in customer's article, a draft, or in
 * no article yet.
 *
 * Any console agent may: the console draws internal articles and drafts, and
 * an editor previews a picture before the article that will show it is saved.
 * A help-centre customer may when an article visible to them shows it, by the
 * same rule their article pages are read with (`kbViewer`, `shownTo`).
 *
 * A module of its own, apart from `./images.ts`, because that one is imported
 * by the worker and this one reads the request's cookies.
 */
export async function mayReadRestrictedImage(id: string): Promise<boolean> {
  if (await getSessionAgent()) return true;
  const viewer = await kbViewer();
  return viewer.kind === 'customer' && (await shownTo(id, viewer));
}
