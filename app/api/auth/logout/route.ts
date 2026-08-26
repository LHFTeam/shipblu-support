import { redirectTo } from '@/lib/http/redirect';
import { destroySession } from '@/lib/auth/session';

/**
 * POST rather than a link: a GET logout can be triggered by any image tag on
 * any page, which is a nuisance rather than a vulnerability but an avoidable
 * one.
 *
 * The redirect is relative on purpose — see `redirectTo`. Deriving it from
 * `request.url` is what sent signed-out agents to `http://localhost:10000/login`.
 */
export async function POST() {
  await destroySession();
  return redirectTo('/login', 303);
}
