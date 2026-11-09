import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * Every body made with `articleBody` is pointed off Freshdesk (`pointedHere`)
 * before the next one is made, so no writer can put Freshdesk's addresses back
 * (`plans/freshdesk-disconnection.md`, PR 2).
 */

/** Two writers that point their bodies here: the rule's floor. */
const WRITERS = many(
  2,
  (i) => `lib/writer${i}.ts`,
  () =>
    'export async function w(html: string) {\n  const body = articleBody(html);\n  return pointedHere(body.bodyHtml, "ar");\n}\n',
);

const run = (files) => runRule('article-off-freshdesk', { ...WRITERS, ...files });

/** A module whose body is `lines`, the first on line 1. */
const body = (...lines) => `${lines.join('\n')}\n`;

describe('article-off-freshdesk', () => {
  it('passes a writer that points each body here, the definition, and tests', async () => {
    const found = await run({
      'app/actions.ts': body(
        'export async function save(html: string) {',
        '  const body = articleBody(html);',
        '  const bodyHtml = await pointedHere(body.bodyHtml, "ar");',
        '}',
        'export async function restore(html: string) {',
        '  const body = articleBody(html);',
        '  const bodyHtml = await pointedHere(body.bodyHtml, "en");',
        '}',
      ),
      'lib/kb/article-write.ts': body(
        'export function articleBody(html: string) {',
        '  return html;',
        '}',
      ),
      'lib/writer.test.ts': body('articleBody("<p>x</p>");'),
      // Prose about the call is not a call.
      'lib/notes.ts': body(
        '// every articleBody(html) is followed by pointedHere',
        'export const x = 1;',
      ),
    });

    expect(found).toEqual([]);
  });

  it('refuses a body never pointed here, and one whose call comes before it', async () => {
    const found = await run({
      'lib/import.ts': body(
        'export async function write(html: string) {',
        '  const body = articleBody(html);',
        '  return body;',
        '}',
      ),
      'app/actions.ts': body(
        'export async function save(html: string) {',
        '  const body = articleBody(html);',
        '  await pointedHere(body.bodyHtml, "ar");',
        '}',
        'export async function restore(html: string) {',
        '  const body = articleBody(html);',
        '  return body;',
        '}',
      ),
      'lib/early.ts': body(
        'export async function write(html: string) {',
        '  const pointed = await pointedHere(html, "ar");',
        '  return articleBody(pointed);',
        '}',
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({ rule: 'article-off-freshdesk', where: 'app/actions.ts:6' }),
      expect.objectContaining({ rule: 'article-off-freshdesk', where: 'lib/early.ts:3' }),
      expect.objectContaining({ rule: 'article-off-freshdesk', where: 'lib/import.ts:2' }),
    ]);
  });

  it('fails when it finds too few writers to be checking anything', async () => {
    const found = await runRule('article-off-freshdesk', {
      'lib/writer.ts': body('const b = articleBody(h);', 'pointedHere(b.bodyHtml, "ar");'),
    });

    expect(found).toEqual([
      expect.objectContaining({ rule: 'article-off-freshdesk', where: 'lib/kb/article-write.ts' }),
    ]);
  });
});
