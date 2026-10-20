import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The signed WhatsApp Web extension, as the console serves it to the laptops.
 *
 * `extension/pack.mjs` writes the package and its `meta.json` during the web
 * service's build; these read them back. Chrome on each laptop polls the update
 * manifest, downloads the CRX it names, and finds both through the policy the
 * install script writes — all three are public, because Chrome's updater
 * carries no session. Nothing in them is secret: the package is useless
 * without an agent's password, and the signing key never leaves the build.
 *
 * Absent — on staging, in CI, on a laptop that never packed — every reader
 * answers null and the routes 404, rather than serving a package somebody
 * built and signed by other means.
 */

export type ExtensionPackage = { id: string; version: string; origin: string };

const metaSchema = z.object({
  // Chrome's spelling of an id: 32 letters a–p.
  id: z.string().regex(/^[a-p]{32}$/),
  // Chrome's version: one to four dot-separated integers.
  version: z.string().regex(/^\d+(\.\d+){0,3}$/),
  origin: z.url(),
});

function packagePath(file: string): string {
  return join(process.cwd(), 'extension', 'package', file);
}

export async function extensionPackage(): Promise<ExtensionPackage | null> {
  try {
    const parsed = metaSchema.safeParse(
      JSON.parse(await readFile(packagePath('meta.json'), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function extensionPackageBytes(): Promise<Buffer | null> {
  try {
    return await readFile(packagePath('shipblu-support.crx'));
  } catch {
    return null;
  }
}

/** Where Chrome asks for the next version. Also baked into the package's own manifest. */
export function updatesUrl(pkg: ExtensionPackage): string {
  return `${pkg.origin}/api/extension/package/updates.xml`;
}

/**
 * The update manifest, in the `gupdate` shape Chrome's extension updater
 * reads: which version is current and where to download it.
 */
export function updateManifest(pkg: ExtensionPackage): string {
  const codebase = `${pkg.origin}/api/extension/package/shipblu-support.crx`;
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>",
    `  <app appid='${attribute(pkg.id)}'>`,
    `    <updatecheck codebase='${attribute(codebase)}' version='${attribute(pkg.version)}' />`,
    '  </app>',
    '</gupdate>',
    '',
  ].join('\n');
}

/**
 * The managed policy a laptop needs, for `install/install-ubuntu.sh` to write
 * into Chrome's policy directory.
 *
 * `ExtensionSettings` rather than `ExtensionInstallForcelist`, for two keys
 * the list cannot carry: `toolbar_pin`, so the icon an agent has to click is on
 * the toolbar rather than behind the puzzle piece, and `override_update_url`,
 * so the policy — not the URL baked into a package already installed — says
 * where updates come from, and moving the console to another host is a policy
 * change rather than a reinstall.
 */
export function installPolicy(pkg: ExtensionPackage) {
  return {
    ExtensionSettings: {
      [pkg.id]: {
        installation_mode: 'force_installed',
        update_url: updatesUrl(pkg),
        override_update_url: true,
        toolbar_pin: 'force_pinned',
      },
    },
  };
}

function attribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
