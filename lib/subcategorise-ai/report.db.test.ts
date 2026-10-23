import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { aiSubcategoryRuns, contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { UNCLASSIFIED_KEY } from '@/lib/subcategorise/taxonomy';
import { CONVERSATION_CHANNELS, type ConversationChannel } from '@/lib/tickets/channel-policy';
import { withCleanDatabase } from '@/lib/testing/db';
import { formatReport, reportFor, runLabels } from './report';

/**
 * The shadow report's reads, against real Postgres.
 *
 * Every figure on `/admin/subcategories/shadow` is a raw template over
 * `ai_subcategory_runs`, which Stage 2.B renamed, so nothing static can tell
 * whether the names it spells still exist — and the arithmetic is the kind
 * only Postgres checks: `count(*) filter` over `= any(<array column>)`, a NOT
 * of a comparison that is null for a failed row, a CASE of half-open bands
 * ordered by their floor, a LEFT JOIN that must keep a run whose message was
 * deleted, and the channel gate on every one of them.
 *
 * One corpus, built so each row lands in a different cell of the report: the
 * rules gave up or did not, the model named a subcategory or gave up too, the
 * two agreed or did not, the call failed, the message was too short for the
 * rules to try, the message was deleted afterwards. The figures below are each
 * the count of named rows, so a wrong filter moves a number rather than
 * leaving a total that happens to match.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();

const WHERE = 'delivery.where_is_it';
const LATE = 'delivery.late';
const ETA = 'delivery.eta_request';
const DAMAGED = 'condition.damaged';

/**
 * What the page passes for somebody holding `admin.subcategories` without
 * `ticket.view.bot` — `hiddenChannels()` answers `['whatsapp_bot']` for them.
 */
const WITHOUT_BOT: ConversationChannel[] = CONVERSATION_CHANNELS.filter(
  (channel) => channel !== 'whatsapp_bot',
);

async function ticket(channel: ConversationChannel): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

async function inbound(conversationId: string, bodyText: string): Promise<string> {
  const [row] = await db
    .insert(messages)
    .values({ conversationId, direction: 'inbound', bodyText })
    .returning({ id: messages.id });
  return row!.id;
}

/** A successful measurement unless the row says otherwise. */
async function run(
  conversationId: string,
  messageId: string | null,
  row: Partial<typeof aiSubcategoryRuns.$inferInsert> & { createdAt: Date },
): Promise<void> {
  await db.insert(aiSubcategoryRuns).values({
    conversationId,
    messageId,
    runLabel: 'baseline',
    model: 'jev-1.13.0',
    latencyMs: 1000,
    ...row,
  });
}

/** A transient failure, written the way `runOne` writes one. */
const FAILED = {
  model: null,
  predictedKey: null,
  probability: null,
  confidence: null,
  inputTokens: null,
  error: 'TypeSafe request timed out after 30000ms',
} as const;

/**
 * Three labels.
 *
 * `baseline` is the corpus: eleven rows, one of them on the bot channel and
 * the last one written, so the gate moves the run's latest instant as well as
 * its counts. `rerun` measures one of the same messages again, a day later,
 * which the unique index allows and the label filter must keep apart. And
 * `bot-only` exists only where the gate hides it.
 */
async function corpus(): Promise<void> {
  const facebook = await ticket('facebook');
  const whatsapp = await ticket('whatsapp');
  const bot = await ticket('whatsapp_bot');

  // facebook, Arabic script. One body is mostly Latin with a single Arabic
  // word, which still reads as Arabic: the class is "any letter in the block".
  const a1 = await inbound(facebook, 'فين الشحنة بتاعتي');
  const a2 = await inbound(facebook, 'ممكن حد يرد');
  const a3 = await inbound(facebook, 'AWB 123456 لسه موصلش');
  const a4 = await inbound(facebook, 'الشحنة اتأخرت امتى هتوصل');
  const a5 = await inbound(facebook, 'السلام عليكم');

  // The rules gave up and the model named one.
  await run(facebook, a1, {
    rulesKeys: [UNCLASSIFIED_KEY],
    predictedKey: WHERE,
    confidence: 0.95,
    inputTokens: 100,
    createdAt: at('2026-10-01T10:00'),
  });
  // Both gave up: an agreement, and on the 0.90 floor exactly.
  await run(facebook, a2, {
    rulesKeys: [UNCLASSIFIED_KEY],
    predictedKey: UNCLASSIFIED_KEY,
    confidence: 0.9,
    inputTokens: 110,
    createdAt: at('2026-10-01T10:05'),
  });
  // The model's choice is the rules' second key, not their first, and on the
  // 0.70 floor exactly. Sent with context.
  await run(facebook, a3, {
    rulesKeys: [LATE, WHERE],
    predictedKey: WHERE,
    confidence: 0.7,
    inputTokens: 120,
    withContext: true,
    createdAt: at('2026-10-01T10:10'),
  });
  // A disagreement, which the report pairs with the rules' strongest key.
  await run(facebook, a4, {
    rulesKeys: [LATE, WHERE],
    predictedKey: ETA,
    confidence: 0.89,
    inputTokens: 130,
    createdAt: at('2026-10-01T10:15'),
  });
  // The call failed where the rules had given up: counted as the rules giving
  // up, never as the model naming one, and in no band.
  await run(facebook, a5, {
    ...FAILED,
    rulesKeys: [UNCLASSIFIED_KEY],
    latencyMs: 30000,
    createdAt: at('2026-10-01T10:20'),
  });

  // facebook, other script.
  const e1 = await inbound(facebook, 'ok?');
  const e2 = await inbound(facebook, 'the box arrived crushed');

  // Too short for the rules to try at all: an empty baseline, which is a
  // disagreement with nothing on the other side.
  await run(facebook, e1, {
    rulesKeys: [],
    predictedKey: WHERE,
    confidence: 0.5,
    inputTokens: 140,
    createdAt: at('2026-10-01T10:25'),
  });
  await run(facebook, e2, {
    rulesKeys: [DAMAGED],
    predictedKey: DAMAGED,
    confidence: 0.49,
    inputTokens: 150,
    createdAt: at('2026-10-01T10:30'),
  });
  // The message was deleted afterwards (`set null`): the measurement survives,
  // and with no body to read its script is not Arabic. An answer with no
  // confidence reported lands in its own band.
  await run(facebook, null, {
    rulesKeys: [UNCLASSIFIED_KEY],
    predictedKey: UNCLASSIFIED_KEY,
    confidence: null,
    inputTokens: 160,
    createdAt: at('2026-10-01T10:35'),
  });

  // whatsapp, Arabic script, after the model alias moved.
  const w1 = await inbound(whatsapp, 'هتوصل امتى');
  const w2 = await inbound(whatsapp, 'محدش بيرد عليا');
  await run(whatsapp, w1, {
    model: 'jev-1.14.0',
    rulesKeys: [ETA],
    predictedKey: ETA,
    confidence: 0.92,
    inputTokens: 170,
    withContext: true,
    createdAt: at('2026-10-01T10:40'),
  });
  await run(whatsapp, w2, {
    model: 'jev-1.14.0',
    rulesKeys: [UNCLASSIFIED_KEY],
    predictedKey: WHERE,
    confidence: 0.6,
    inputTokens: 180,
    createdAt: at('2026-10-01T10:45'),
  });

  // The bot channel, written last of the baseline. Everything it touches is
  // what the gate has to take back out.
  const b1 = await inbound(bot, 'عايز اتابع شحنتي');
  await run(bot, b1, {
    rulesKeys: [UNCLASSIFIED_KEY],
    predictedKey: WHERE,
    confidence: 0.95,
    inputTokens: 200,
    withContext: true,
    createdAt: at('2026-10-02T12:00'),
  });

  // The same message as the first baseline row, measured again.
  await run(facebook, a1, {
    runLabel: 'rerun',
    model: 'jev-1.14.0',
    rulesKeys: [UNCLASSIFIED_KEY],
    predictedKey: LATE,
    confidence: 0.99,
    inputTokens: 900,
    createdAt: at('2026-10-02T09:00'),
  });
  await run(facebook, a2, {
    ...FAILED,
    runLabel: 'rerun',
    rulesKeys: [UNCLASSIFIED_KEY],
    createdAt: at('2026-10-02T09:05'),
  });

  await run(bot, await inbound(bot, 'القائمة'), {
    runLabel: 'bot-only',
    rulesKeys: [UNCLASSIFIED_KEY],
    predictedKey: UNCLASSIFIED_KEY,
    confidence: 0.97,
    createdAt: at('2026-10-03T08:00'),
  });
}

describe('runLabels', () => {
  beforeEach(async () => {
    await corpus();
  });

  it('lists every run, newest last row first, with its size and failures', async () => {
    expect(await runLabels()).toEqual([
      { runLabel: 'bot-only', rows: 1, failed: 0, lastAt: at('2026-10-03T08:00') },
      { runLabel: 'baseline', rows: 11, failed: 1, lastAt: at('2026-10-02T12:00') },
      { runLabel: 'rerun', rows: 2, failed: 1, lastAt: at('2026-10-02T09:05') },
    ]);
  });

  it('counts, dates and orders a run by the rows the caller may see', async () => {
    // Without the bot row the baseline's latest instant is the day before the
    // rerun's, so the order changes with the gate as well as the counts — and
    // the page's default selection, `runs[0]`, with it. A run with nothing
    // visible is not offered at all.
    expect(await runLabels(WITHOUT_BOT)).toEqual([
      { runLabel: 'rerun', rows: 2, failed: 1, lastAt: at('2026-10-02T09:05') },
      { runLabel: 'baseline', rows: 10, failed: 1, lastAt: at('2026-10-01T10:45') },
    ]);
  });
});

describe('reportFor', () => {
  beforeEach(async () => {
    await corpus();
  });

  it('breaks the run down by channel and script, largest slice first', async () => {
    const { slices } = await reportFor('baseline', WITHOUT_BOT);

    expect(slices).toEqual([
      {
        channel: 'facebook',
        script: 'arabic',
        rows: 5,
        predicted: 4,
        failed: 1,
        // a1, a2 and the failed a5.
        rulesUnclassified: 3,
        // a1 only: a2 gave up too, and a5 answered nothing.
        namedWhereRulesGaveUp: 1,
        // a2 (both gave up) and a3 (the rules' second key).
        agreed: 2,
        // Over the rows that reported one: a failure's null is not a zero.
        avgConfidence: expect.closeTo((0.95 + 0.9 + 0.7 + 0.89) / 4, 10),
      },
      {
        channel: 'facebook',
        script: 'other',
        rows: 3,
        predicted: 3,
        failed: 0,
        // The deleted message, whose row is kept by the LEFT JOIN.
        rulesUnclassified: 1,
        namedWhereRulesGaveUp: 0,
        // e2, and the deleted message where both gave up. An empty baseline
        // agrees with nothing.
        agreed: 2,
        // The deleted message's unreported confidence is left out the same way.
        avgConfidence: expect.closeTo((0.5 + 0.49) / 2, 10),
      },
      {
        channel: 'whatsapp',
        script: 'arabic',
        rows: 2,
        predicted: 2,
        failed: 0,
        rulesUnclassified: 1,
        namedWhereRulesGaveUp: 1,
        agreed: 1,
        avgConfidence: expect.closeTo((0.92 + 0.6) / 2, 10),
      },
    ]);
  });

  it('bands the answers on half-open floors, highest first, failures left out', async () => {
    const { bands } = await reportFor('baseline', WITHOUT_BOT);

    // Ordered by each band's lowest member rather than by its label, which as
    // text would put "below 0.50" above "0.90 and up"; the unreported band has
    // no floor and goes last.
    expect(bands).toEqual([
      // a1, a2 (0.90 exactly), w1.
      { band: '0.90 and up', rows: 3, saidUnclassified: 1, agreedWithRules: 2 },
      // a3 (0.70 exactly), a4 (0.89).
      { band: '0.70 to 0.89', rows: 2, saidUnclassified: 0, agreedWithRules: 1 },
      // e1 (0.50 exactly), w2.
      { band: '0.50 to 0.69', rows: 2, saidUnclassified: 0, agreedWithRules: 0 },
      { band: 'below 0.50', rows: 1, saidUnclassified: 0, agreedWithRules: 1 },
      { band: 'unreported', rows: 1, saidUnclassified: 1, agreedWithRules: 1 },
    ]);
  });

  it("pairs each disagreement with the rules' strongest key, most common first", async () => {
    const { disagreements } = await reportFor('baseline', WITHOUT_BOT);

    // a1 and w2 make the recurring pair. a4's rules named LATE before WHERE,
    // so it is filed against LATE. e1's rules named nothing at all — a NOT
    // over `= any('{}')` is true, so it is here rather than lost. The failed
    // row's comparison is null and is not a disagreement.
    expect(disagreements[0]).toEqual({ aiKey: WHERE, rulesKey: UNCLASSIFIED_KEY, rows: 2 });
    expect(disagreements.slice(1).sort((a, b) => a.aiKey.localeCompare(b.aiKey))).toEqual([
      { aiKey: ETA, rulesKey: LATE, rows: 1 },
      { aiKey: WHERE, rulesKey: '(none)', rows: 1 },
    ]);
  });

  it('totals what the run holds, over the rows the caller may see', async () => {
    const report = await reportFor('baseline', WITHOUT_BOT);

    expect(report.runLabel).toBe('baseline');
    // Distinct and without the failed row's null; the bot row's model is one
    // of these anyway, so the gate is read off the other totals.
    expect(report.models).toEqual(['jev-1.13.0', 'jev-1.14.0']);
    expect(report.totals).toEqual({
      rows: 10,
      predicted: 9,
      failed: 1,
      // 100 + 110 + … + 180; the failed row's null adds nothing.
      inputTokens: 1260,
      // The failure's 30 s round trip counts: it was paid for.
      avgLatencyMs: (9 * 1000 + 30000) / 10,
      firstAt: at('2026-10-01T10:00'),
      lastAt: at('2026-10-01T10:45'),
      withContext: 2,
    });
  });

  it('with no gate, reports the bot channel too', async () => {
    const report = await reportFor('baseline');

    expect(report.totals).toMatchObject({
      rows: 11,
      predicted: 10,
      inputTokens: 1460,
      withContext: 3,
      lastAt: at('2026-10-02T12:00'),
    });
    expect(report.slices.map((slice) => [slice.channel, slice.script, slice.rows])).toEqual([
      ['facebook', 'arabic', 5],
      ['facebook', 'other', 3],
      ['whatsapp', 'arabic', 2],
      ['whatsapp_bot', 'arabic', 1],
    ]);
    expect(report.bands[0]).toEqual({
      band: '0.90 and up',
      rows: 4,
      saidUnclassified: 1,
      agreedWithRules: 2,
    });
    expect(report.disagreements[0]).toEqual({
      aiKey: WHERE,
      rulesKey: UNCLASSIFIED_KEY,
      rows: 3,
    });
  });

  it('reads one label, though the same message was measured under another', async () => {
    const report = await reportFor('rerun', WITHOUT_BOT);

    expect(report.models).toEqual(['jev-1.14.0']);
    expect(report.totals).toMatchObject({ rows: 2, predicted: 1, failed: 1, inputTokens: 900 });
    expect(report.slices).toEqual([
      {
        channel: 'facebook',
        script: 'arabic',
        rows: 2,
        predicted: 1,
        failed: 1,
        rulesUnclassified: 2,
        namedWhereRulesGaveUp: 1,
        agreed: 0,
        avgConfidence: 0.99,
      },
    ]);
    expect(report.bands).toEqual([
      { band: '0.90 and up', rows: 1, saidUnclassified: 0, agreedWithRules: 0 },
    ]);
    expect(report.disagreements).toEqual([{ aiKey: LATE, rulesKey: UNCLASSIFIED_KEY, rows: 1 }]);
  });

  it('answers an empty report for a run the caller can see none of', async () => {
    const report = await reportFor('bot-only', WITHOUT_BOT);

    // The aggregate with no GROUP BY still answers one row, of zeroes and
    // nulls, and each must come back as the empty value rather than NaN or
    // an Invalid Date the page would print.
    expect(report).toEqual({
      runLabel: 'bot-only',
      models: [],
      slices: [],
      bands: [],
      disagreements: [],
      totals: {
        rows: 0,
        predicted: 0,
        failed: 0,
        inputTokens: 0,
        avgLatencyMs: null,
        firstAt: null,
        lastAt: null,
        withContext: 0,
      },
    });
    expect(formatReport(report)).toContain('nothing to compare yet');

    // And the same run, ungated, is there.
    expect((await reportFor('bot-only')).totals.rows).toBe(1);
  });
});

describe('formatReport over a real report', () => {
  it('prints the figures the queries produced, in the order they produced them', async () => {
    await corpus();
    const text = formatReport(await reportFor('baseline', WITHOUT_BOT));

    expect(text.split('\n')).toEqual([
      'run "baseline" — 10 messages measured',
      '  models: jev-1.13.0, jev-1.14.0',
      '  predicted 9, failed 1, 1260 input tokens, 3900ms avg latency',
      '  per channel and script — rows / rules gave up / model named one / agreed:',
      '    facebook/arabic: 5 / 3 / 1 / 2 (1 failed)',
      '    facebook/other: 3 / 1 / 0 / 2',
      '    whatsapp/arabic: 2 / 1 / 1 / 1',
      '  by confidence band — rows / said unclassified / agreed with rules:',
      '    0.90 and up: 3 / 1 / 2',
      '    0.70 to 0.89: 2 / 0 / 1',
      '    0.50 to 0.69: 2 / 0 / 0',
      '    below 0.50: 1 / 0 / 1',
      '    unreported: 1 / 1 / 1',
      '  where they differ — model vs rules:',
      `    ${WHERE} vs ${UNCLASSIFIED_KEY}: 2`,
      // The two single pairs tie; either order is the query's to choose.
      expect.stringMatching(
        /^ {4}delivery\.(eta_request vs delivery\.late|where_is_it vs \(none\)): 1$/,
      ),
      expect.stringMatching(
        /^ {4}delivery\.(eta_request vs delivery\.late|where_is_it vs \(none\)): 1$/,
      ),
    ]);
  });
});
