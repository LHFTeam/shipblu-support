import { extensionPackage, updateManifest } from '@/lib/extension/package';

export const dynamic = 'force-dynamic';

/**
 * The update manifest Chrome polls on every laptop with the extension
 * installed. Public, because Chrome's updater carries no session; see
 * `lib/extension/package.ts`.
 */
export async function GET() {
  const pkg = await extensionPackage();
  if (!pkg) return new Response('No extension package on this deploy', { status: 404 });

  return new Response(updateManifest(pkg), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
