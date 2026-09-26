import { fail, read } from '../lib.mjs';

/**
 * render.yaml must not become the place a secret lives.
 *
 * Two separate rules, both already written down and both easy to break by
 * copying a nearby line:
 *
 *   - `sync: false` is not allowed inside an environment group. Render's
 *     blueprint reference rules it out, and a group entry needs either a literal
 *     value or `generateValue` — so a group's dashboard-owned keys are listed as
 *     a comment instead.
 *   - A key declared in more than one group is the trap without the precedence
 *     rule to settle it. Render gives service-level variables precedence over
 *     group values; two groups linked by one service have no such tiebreak.
 */
export function checkRenderGroups() {
  const rule = 'render-groups';
  const lines = read('render.yaml').split('\n');

  /**
   * render.yaml as a list of `- name:` blocks.
   *
   * Both env groups and services are written that way, and they are told apart
   * by what is inside: a service declares `type:`, a group does not. Parsing by
   * indentation rather than by a YAML library keeps this script dependency-free
   * — the blueprint is hand-written and its shape is stable.
   */
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)-\s*name:\s*(.+?)\s*$/);
    if (!open) continue;
    const indent = open[1].length;

    // Which list this entry belongs to — the nearest key above it at a
    // shallower indent. `envVarGroups:` makes it a group, `services:` a service;
    // `projects:` and `environments:` entries are neither and are skipped, which
    // is what stops a project block from swallowing the services nested in it.
    let section = null;
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j];
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      const at = line.search(/\S/);
      if (at < indent && /^\s*[A-Za-z]+:\s*$/.test(line)) {
        section = line.trim().replace(':', '');
        break;
      }
    }
    if (section !== 'envVarGroups' && section !== 'services') continue;

    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const at = line.search(/\S/);
      if (at <= indent) break;
      body.push([j, line]);
    }
    blocks.push({
      name: open[2].replace(/^['"]|['"]$/g, ''),
      kind: section === 'envVarGroups' ? 'group' : 'service',
      body,
    });
  }

  const groups = new Map();
  const services = [];

  for (const block of blocks) {
    if (block.kind === 'service') {
      services.push({
        name: block.name,
        linked: block.body
          .map(([, l]) => l.match(/^\s*-\s*fromGroup:\s*(\S+)/))
          .filter(Boolean)
          .map((m) => m[1]),
      });
      continue;
    }

    const keys = new Map();
    for (let k = 0; k < block.body.length; k++) {
      const [lineNo, line] = block.body[k];
      const key = line.match(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)/);
      if (!key) continue;
      keys.set(key[1], lineNo + 1);

      // `sync: false` is not allowed inside an environment group: Render's
      // blueprint reference rules it out, and a group entry needs either a
      // literal value or `generateValue`. A literal would put the secret in the
      // repo and `value: ''` would blank the real one on the next sync, so a
      // group's dashboard-owned keys are listed as a comment instead.
      const rest = block.body
        .slice(k + 1, k + 4)
        .map(([, l]) => l)
        .join('\n');
      if (/^\s*sync:\s*false/m.test(rest)) {
        fail(
          rule,
          `render.yaml:${lineNo + 1}`,
          `${key[1]} uses \`sync: false\` inside env group ${block.name} — Render does not allow it in a group; list the key in the group's dashboard-owned comment instead`,
        );
      }
    }
    if (keys.size > 0 || /envVars:/.test(block.body.map(([, l]) => l).join('\n'))) {
      groups.set(block.name, keys);
    }
  }

  /**
   * A key declared in two groups is only a problem when one service links both.
   *
   * Production and staging deliberately declare EMAIL_PROVIDER differently —
   * that is the whole point of splitting them, and nothing links both. What has
   * no tiebreak is two groups linked by the *same* service: Render's precedence
   * rule settles a service value against a group value, and says nothing about
   * one group against another.
   */
  for (const service of services) {
    const seen = new Map();
    for (const groupName of service.linked) {
      for (const key of groups.get(groupName)?.keys() ?? []) {
        const already = seen.get(key);
        if (already) {
          fail(
            rule,
            'render.yaml',
            `${key} is declared in both ${already} and ${groupName}, and service ${service.name} links both — which value wins is undefined; declare it in exactly one`,
          );
        }
        seen.set(key, groupName);
      }
    }
  }
}
