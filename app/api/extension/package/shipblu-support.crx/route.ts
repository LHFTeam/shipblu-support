import { extensionPackageBytes } from '@/lib/extension/package';

export const dynamic = 'force-dynamic';

/** The signed package itself, which the update manifest names. */
export async function GET() {
  const bytes = await extensionPackageBytes();
  if (!bytes) return new Response('No extension package on this deploy', { status: 404 });

  return new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'application/x-chrome-extension', 'cache-control': 'no-cache' },
  });
}
