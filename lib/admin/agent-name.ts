/**
 * A cap on an agent's name, checked server-side wherever one is written,
 * because an action is reachable without its form. Unbounded, a name reaches
 * every inbox row and assignment dropdown that renders an agent — one paste of
 * a large clipboard buffer away.
 *
 * Every writer shares it — the invite, the activation page, the first admin's
 * setup and the agent editor — so a name one of them accepted is one the editor
 * will save back: the editor sends the name with every save, and a browser's
 * `maxLength` does not trim a `defaultValue` it was handed, so a longer name
 * accepted anywhere would refuse every later change to that agent until
 * somebody rewrote it.
 *
 * A module of its own, importing nothing, so a form can hold the number the
 * server refuses on: `agent-profile.ts` imports the database, and a client
 * component importing a constant from it would ship the schema (§6.57).
 */
export const MAX_AGENT_NAME = 120;
