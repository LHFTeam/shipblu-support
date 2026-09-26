import { fail, scannable, scan } from '../lib.mjs';

/**
 * FORCE row level security, anywhere.
 *
 * The app connects as the table owner, which bypasses RLS — that is what makes
 * an enabled-but-policy-less table readable by the app and closed to everyone
 * else. FORCE removes the owner's bypass and every query in the system starts
 * returning nothing. It is the one rule in AGENTS.md whose blast radius is the
 * whole product, and it is a single word.
 */
export function checkNoForceRls() {
  scan(
    scannable.filter((f) => /\.(sql|ts|tsx)$/.test(f)),
    /FORCE\s+ROW\s+LEVEL\s+SECURITY/gi,
    (file, line) => {
      fail(
        'force-rls',
        `${file}:${line}`,
        'FORCE ROW LEVEL SECURITY — the app connects as the table owner, so this breaks every query in the system',
      );
    },
  );
}
