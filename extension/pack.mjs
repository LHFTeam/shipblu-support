/**
 * Builds the extension and signs it as the CRX the laptops install.
 *
 *   EXTENSION_SIGNING_KEY="$(cat key.pem)" npm run extension:pack
 *
 * Writes `extension/package/shipblu-support.crx` and `meta.json` (its id,
 * version and origin), which the console serves under
 * `/api/extension/package/` — the update manifest Chrome polls, the package
 * it downloads, and the policy `install/install-ubuntu.sh` writes.
 *
 * Runs in the web service's Render build, after `npm run build`. Without a key
 * it packs nothing and says so: staging, CI and a laptop building for itself
 * have no business holding the key, and the console then answers 404 for the
 * package rather than serving one signed by something else.
 *
 * The origin is `SUPPORT_ORIGIN`, else `APP_URL` — the address the console is
 * reached at, which on Render is already set for the service that builds this.
 * It is baked into the package three times (host permission, API base, update
 * URL), so a package built for one console never talks to another.
 *
 * To ship a change to the laptops, bump `version` in `extension/manifest.json`.
 * Chrome installs an update only when the advertised version is higher than
 * the one it has; the same version, rebuilt, is left where it is.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension, supportOrigin } from './build.mjs';
import { crx3, zip } from './crx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, 'package');

/**
 * The key as a PEM, from however it was pasted: a PEM with real line breaks,
 * one whose breaks were flattened to `\n` by a single-line field, or the PEM
 * base64-encoded whole.
 */
function signingKey(raw) {
  const value = raw.trim();
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  return Buffer.from(value, 'base64').toString('utf8');
}

async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  }
  return found.sort();
}

const key = process.env.EXTENSION_SIGNING_KEY;
await rm(packageDir, { recursive: true, force: true });

if (!key) {
  process.stdout.write('EXTENSION_SIGNING_KEY is not set: no extension package built\n');
} else {
  const origin = supportOrigin(process.env.SUPPORT_ORIGIN || process.env.APP_URL);
  const updateUrl = `${origin}/api/extension/package/updates.xml`;
  const { out, version } = await buildExtension({ origin, updateUrl });

  const entries = await Promise.all(
    (await filesUnder(out)).map(async (file) => ({
      name: relative(out, file).split('\\').join('/'),
      data: await readFile(file),
    })),
  );
  const { crx, id } = crx3(zip(entries), signingKey(key));

  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'shipblu-support.crx'), crx);
  await writeFile(
    join(packageDir, 'meta.json'),
    `${JSON.stringify({ id, version, origin }, null, 2)}\n`,
  );
  process.stdout.write(`extension ${id} ${version} packed (${crx.length} bytes)\n`);
}
