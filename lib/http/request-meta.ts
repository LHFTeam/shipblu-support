import { headers } from 'next/headers';

/**
 * Who is signing in, as a session row records it: the client address and the
 * user agent of the request an action is answering. Shared by the agent and
 * customer sign-in actions, which each carried this copy.
 *
 * Not `clientIpFrom` in `./rate-limit`, although both read the same headers.
 * That one answers `'unknown'` so a rate-limit key is never empty; this one
 * answers `null`, because the value is stored and "not known" is a null
 * column, not a string that looks like an address.
 */
export async function requestMeta() {
  const headerList = await headers();
  return {
    ip:
      headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      headerList.get('x-real-ip') ??
      null,
    userAgent: headerList.get('user-agent'),
  };
}
