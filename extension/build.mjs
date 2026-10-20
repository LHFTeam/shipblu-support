/**
 * Builds the WhatsApp Web extension into `extension/dist`, ready to load
 * unpacked or to pack (`pack.mjs`).
 *
 *   npm run extension:build                                  # production console
 *   SUPPORT_ORIGIN=http://localhost:3000 npm run extension:build   # local
 *
 * `SUPPORT_ORIGIN` is baked in rather than typed by the agent: it is both the
 * one host the extension may call (its manifest's host permission) and where
 * the agent's password is sent, so it is decided by whoever builds the package
 * that the laptops install, not by a field in the panel.
 *
 * The panel's stylesheet is compiled from `app/globals.css` by the same
 * Tailwind the console uses, scanning the panel and `components/`, so the
 * panel draws the console's own primitives (`Button`, `Badge`, `StatusBadge`)
 * in the console's tokens rather than a copy of them that would drift.
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { build } from 'esbuild';
import postcss from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'dist');

const PRODUCTION_ORIGIN = 'https://shipblu-support.onrender.com';

/**
 * An origin and nothing else. A path or a trailing slash here would become a
 * host permission Chrome refuses, or an API base every fetch doubles a slash
 * onto, and the failure would show up only on a laptop.
 *
 * @param {string | undefined} raw
 */
export function supportOrigin(raw) {
  const value = raw || PRODUCTION_ORIGIN;
  const url = new URL(value);
  if (url.origin !== value.replace(/\/$/, '')) {
    throw new Error(`the console origin must be like ${PRODUCTION_ORIGIN}, not ${value}`);
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error(
      'the console origin must be https, except for localhost: a password is sent there',
    );
  }
  return url.origin;
}

/**
 * Node's built-ins, answered with a module that throws on use.
 *
 * The panel imports pure helpers from `lib/` the console's own client
 * components import — `lib/side-conversations/format.ts` among them — and some
 * of those sit beside a server-only function in the same module: format.ts
 * reaches `node:crypto` through `lib/email/threading.ts`, for the reply-token
 * HMAC the panel never computes. Next's client bundle resolves such an import
 * to an empty module; this does the same, except that calling anything off it
 * says what happened instead of failing as "undefined is not a function".
 */
const nodeBuiltinsThrow = {
  name: 'node-builtins-throw',
  setup(builder) {
    builder.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: 'node-stub',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'node-stub' }, (args) => ({
      loader: 'js',
      contents: `
        const unavailable = (name) => () => {
          throw new Error(${JSON.stringify(args.path)} + '.' + name + ' is not available in the extension');
        };
        module.exports = new Proxy({}, {
          get: (_, name) => (name === '__esModule' || typeof name === 'symbol' ? undefined : unavailable(name)),
        });
      `,
    }));
  },
};

/**
 * Builds into `dist/` and answers where, and the version it carries.
 *
 * `updateUrl` is set only by `pack.mjs`: it is where an installed package asks
 * for its next version, and an unpacked build has nowhere to ask.
 *
 * @param {{ origin?: string; updateUrl?: string }} [options]
 */
export async function buildExtension({
  origin = supportOrigin(process.env.SUPPORT_ORIGIN),
  updateUrl,
} = {}) {
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'icons'), { recursive: true });
  await mkdir(join(out, 'fonts'), { recursive: true });

  await build({
    plugins: [nodeBuiltinsThrow],
    entryPoints: {
      background: join(here, 'src/background.ts'),
      content: join(here, 'src/content.ts'),
      panel: join(here, 'src/panel/main.tsx'),
    },
    outdir: out,
    bundle: true,
    // The service worker is declared a module; the content script cannot be
    // one, and an IIFE suits all three since none of them exports anything.
    format: 'iife',
    target: 'chrome116',
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    // `@/` as the app resolves it, so the panel imports the console's
    // components and pure `lib/` modules by the same paths the console does.
    alias: { '@': root },
    define: {
      'process.env.NODE_ENV': '"production"',
      __SUPPORT_ORIGIN__: JSON.stringify(origin),
    },
    logLevel: 'warning',
  });

  const manifest = JSON.parse(await readFile(join(here, 'manifest.json'), 'utf8'));
  manifest.host_permissions = manifest.host_permissions.map((host) =>
    host.replace('__SUPPORT_ORIGIN__', origin),
  );
  if (updateUrl) manifest.update_url = updateUrl;
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  await copyFile(join(here, 'src/panel/panel.html'), join(out, 'panel.html'));
  for (const icon of await readdir(join(here, 'icons'))) {
    await copyFile(join(here, 'icons', icon), join(out, 'icons', icon));
  }

  const cssEntry = join(here, 'src/panel/panel.css');
  const css = await postcss([tailwind({ base: here })]).process(await readFile(cssEntry, 'utf8'), {
    from: cssEntry,
    to: join(out, 'panel.css'),
  });
  // The console's Arabic faces. Tailwind rewrites `globals.css`'s `./fonts/…`
  // to a path from the panel's source (`../../../app/fonts/…`), which means
  // nothing inside `dist/`; they are copied beside the sheet and named from
  // there.
  const fontUrls = /url\((['"]?)(?:\.\.\/)+app\/fonts\//g;
  const sheet = css.css.replace(fontUrls, 'url($1fonts/');
  if (/app\/fonts\//.test(sheet))
    throw new Error('panel.css still names app/fonts/ after rewriting');
  await writeFile(join(out, 'panel.css'), sheet);

  for (const font of await readdir(join(root, 'app/fonts'))) {
    await copyFile(join(root, 'app/fonts', font), join(out, 'fonts', font));
  }

  process.stdout.write(`extension ${manifest.version} built for ${origin} in ${out}\n`);
  return { out, version: String(manifest.version) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await buildExtension();
}
