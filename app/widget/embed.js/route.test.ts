import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_SAYS, SOURCE, WIDGET_SAYS } from '@/lib/widget/protocol';
import { GET } from './route';

/**
 * The snippet is JavaScript written inside a template literal, which is the one
 * shape in this repo where a syntax error is invisible to every other check:
 * `tsc` type-checks the string, `eslint` lints the string, and the file it
 * generates is never parsed until a browser somewhere on shipblu.com tries to.
 * One unescaped backtick or `${` ends the literal early, and what ships is a
 * truncated program that throws on load — on every page carrying the tag, at
 * once, with no launcher and nothing in the request logs to say why.
 *
 * So: parse what is actually served, with the parser that will have to.
 */
describe('the embed snippet', () => {
  it('parses as JavaScript', async () => {
    const body = await (await GET()).text();

    const file = join(mkdtempSync(join(tmpdir(), 'shipblu-embed-')), 'embed.js');
    writeFileSync(file, body);

    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
  });

  /**
   * Every name a host page is documented to call, checked against what the
   * object literal actually assigns. `docs/embedding-the-widget.md` is a
   * contract somebody else's deployed code implements: a method quietly renamed
   * here fails in their console, not ours.
   */
  it('exposes the whole host API', async () => {
    const body = await (await GET()).text();

    for (const method of ['identify', 'clear', 'setLocale', 'compose', 'open', 'close', 'toggle']) {
      expect(body).toMatch(new RegExp(`^\\s*${method}:`, 'm'));
    }
  });

  /**
   * The snippet speaks the frame's protocol by name, and a name that is not in
   * `lib/widget/protocol.ts` reads as `undefined` in the browser — no error,
   * just a message the frame ignores. So every name the served script reaches
   * for has to be declared, and no quoted wire value may be left behind to
   * drift from the frame's copy.
   */
  it('speaks only the names lib/widget/protocol.ts declares', async () => {
    const body = await (await GET()).text();
    const declared: Record<string, Record<string, string>> = { SOURCE, WIDGET_SAYS, HOST_SAYS };

    const used = [...body.matchAll(/\b(SOURCE|WIDGET_SAYS|HOST_SAYS)\.(\w+)/g)];
    expect(used.length).toBeGreaterThanOrEqual(13);
    for (const [, group, name] of used) {
      expect(Object.keys(declared[group!]!)).toContain(name);
    }

    expect(body).not.toMatch(/'shipblu-(host|widget)'/);
  });
});
