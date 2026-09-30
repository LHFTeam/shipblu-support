import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { AGENT_COLORS } from './agent-colors';

/**
 * The agent tile colour is chosen by a trigger (`db/sql/006_agent_avatar_colors.sql`)
 * and drawn by the app (`agent-colors.ts`), so the two lists have to be the
 * same list, and the colour has to stay where it was put. Both are pinned here
 * rather than trusted.
 */

withCleanDatabase();

async function createAgents(count: number, from = 0) {
  const rows = [];
  // One at a time, as the setup and invite paths create them: each insert has
  // to see the colours handed out before it.
  for (let i = from; i < from + count; i++) {
    const [row] = await db
      .insert(agents)
      .values({ name: 'Mohamed Ali', email: `mohamed${i}@shipblu.test` })
      .returning({ id: agents.id, avatarColor: agents.avatarColor });
    rows.push(row!);
  }
  return rows;
}

describe('agent avatar colours', () => {
  it('uses the same palette in the trigger as the app renders', async () => {
    const result = await db.execute<{ palette: string[] }>(
      sql`SELECT agent_avatar_palette() AS palette`,
    );
    expect(result[0]!.palette).toEqual([...AGENT_COLORS]);
  });

  it('gives each new agent the least-used colour, so nobody shares until the palette runs out', async () => {
    // The seed writes no agents, so every colour counted is one handed out here.
    expect(await db.$count(agents)).toBe(0);

    const first = await createAgents(AGENT_COLORS.length);
    // Same name every time, which is the case colour exists for.
    expect(first.map((row) => row.avatarColor)).toEqual([...AGENT_COLORS]);

    // Past the palette the colours fill evenly again, from the start.
    const next = await createAgents(2, AGENT_COLORS.length);
    expect(next.map((row) => row.avatarColor)).toEqual([AGENT_COLORS[0], AGENT_COLORS[1]]);
  });

  it('keeps a colour a caller chose, and never moves one once assigned', async () => {
    const [chosen] = await db
      .insert(agents)
      .values({ name: 'Sara Adel', email: 'sara@shipblu.test', avatarColor: 'slate' })
      .returning();
    expect(chosen!.avatarColor).toBe('slate');

    const [other] = await createAgents(1);
    await db.update(agents).set({ name: 'Mohamed A.' }).where(eq(agents.id, other!.id));
    const [reread] = await db
      .select({ avatarColor: agents.avatarColor })
      .from(agents)
      .where(eq(agents.id, other!.id));
    expect(reread!.avatarColor).toBe(other!.avatarColor);
  });
});
