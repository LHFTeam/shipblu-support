import { fail, read } from '../lib.mjs';

const SQL = 'db/sql/001_extensions_and_triggers.sql';
const SCHEMA = 'db/schema/kb.ts';

/**
 * `touch_updated_at()` keeps `kb_articles.updated_at` when an UPDATE changes
 * nothing but the columns it names in `not_an_edit` (PROJECT-STATE §6.51), and
 * it names them as strings that have to match `db/schema/kb.ts`. Nothing else
 * ties the two together: `jsonb - text[]` drops a key that is not there without
 * a word, so a renamed `view_count` turns every view back into an edit, a new
 * counter a reader writes does the same from the day it ships, and a new
 * generated column, which reads null in a BEFORE trigger, makes every row look
 * changed. Each of those passes every test that does not happen to name it.
 *
 * So every name in the list is a column of the table, every integer column
 * named `*_count` is in it (the shape the three reader counters have, and the
 * one a fourth would take), and so is every generated column. A counter that a
 * person edits, if one is ever added, is renamed or the rule is changed here
 * with its reason.
 */
export function checkKbEditDate() {
  const rule = 'kb-edit-date';

  const list = /not_an_edit\s+constant\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/i.exec(read(SQL));
  if (!list) {
    fail(
      rule,
      SQL,
      'touch_updated_at() no longer declares not_an_edit as a literal array this can read',
    );
    return;
  }
  const listed = new Set([...list[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
  if (listed.size === 0) {
    fail(rule, SQL, 'not_an_edit parsed as empty');
    return;
  }

  const table = /pgTable\(\s*'kb_articles',\s*\{([\s\S]*?)\n {2}\},/.exec(read(SCHEMA));
  if (!table) {
    fail(rule, SCHEMA, 'the kb_articles table definition is no longer a shape this can read');
    return;
  }

  // One entry per column property, `name: builder('column'…`, with the text up
  // to the next one so a chained `.generatedAlwaysAs(` belongs to its column.
  const body = table[1];
  const starts = [...body.matchAll(/^\s+\w+:\s*(\w+)\(\s*'([a-z_]+)'/gm)];
  const columns = starts.map((match, i) => ({
    builder: match[1],
    name: match[2],
    declaration: body.slice(match.index, starts[i + 1]?.index ?? body.length),
  }));
  const names = new Set(columns.map((column) => column.name));

  for (const name of listed) {
    if (!names.has(name)) {
      fail(
        rule,
        SQL,
        `not_an_edit names "${name}", which is not a column of kb_articles — a renamed counter makes every write to it an edit again`,
      );
    }
  }

  for (const column of columns) {
    if (listed.has(column.name)) continue;
    if (column.builder === 'integer' && column.name.endsWith('_count')) {
      fail(
        rule,
        SCHEMA,
        `kb_articles.${column.name} looks like a counter readers write, and not_an_edit in ${SQL} does not name it, so every write to it moves updated_at`,
      );
    }
    if (/\.generatedAlwaysAs\(/.test(column.declaration)) {
      fail(
        rule,
        SCHEMA,
        `kb_articles.${column.name} is a generated column, which reads null in a BEFORE trigger, and not_an_edit in ${SQL} does not name it, so every UPDATE moves updated_at`,
      );
    }
  }
}
