import { NextResponse } from 'next/server';
import { extensionPackage, installPolicy } from '@/lib/extension/package';

export const dynamic = 'force-dynamic';

/**
 * The Chrome policy that installs the extension, for
 * `extension/install/install-ubuntu.sh` to fetch, so the script never has to
 * be edited when the package's id or the console's address changes.
 */
export async function GET() {
  const pkg = await extensionPackage();
  if (!pkg)
    return NextResponse.json({ error: 'No extension package on this deploy' }, { status: 404 });

  return NextResponse.json(installPolicy(pkg), { headers: { 'cache-control': 'no-cache' } });
}
