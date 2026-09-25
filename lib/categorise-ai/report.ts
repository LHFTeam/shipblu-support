import { inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { UNCLASSIFIED_KEY } from '@/lib/categorise/taxonomy';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';

/**
 * What a shadow run found, read back out.
 *
 * Every figure here is broken down before it is totalled, and that is the point
 * rather than thoroughness for its own sake. This corpus is 89% one channel and
 * majority Arabic; a single headline accuracy number over it would be a statement
 * about Facebook that reads as a statement about the product. The same argument
 * `docs/PROJECT-STATE.md` makes about silent successes — break a count down along
 * the dimension that can fail systematically, per channel and per script.
 *
 * **Every query here joins `conversations`, so every one of them takes the
 * channel gate.** That is the lesson `/admin/categories/review` carries in its
 * own most important line: a query that reaches `conversations` and is served to
 * anybody holding an admin permission has quietly routed around
 * `ticket.view.bot`. Aggregates are a weaker leak than the ticket list that page
 * shows, which is a reason to apply the same rule rather than to invent a softer
 * one. `undefined` means no caller to gate — the job handler, running as cron.
 *
 * `count(*)` is a bigint, which postgres.js hands over as a string, so everything
 * is coerced on the way out rather than at each call site.
 */

/** No gate, or an `in (…)` over exactly what this caller may see. */
function channelGate(visibleChannels: readonly ConversationChannel[] | undefined): SQL {
  if (visibleChannels === undefined) return sql``;
  // `inArray` and not `= any(${list})` — the second reads identically and is the
  // §6.46 trap, because a JS array interpolates as one bind parameter per element
  // and reaches Postgres as a row constructor.
  return sql` AND ${inArray(conversations.channel, [...visibleChannels])}`;
}

export type SliceRow = {
  channel: string;
  script: 'arabic' | 'other';
  rows: number;
  predicted: number;
  failed: number;
  /** Where the rules gave up. The pile this whole exercise exists to attack. */
  rulesUnclassified: number;
  /** ...and of those, where the model named an actual category instead. */
  namedWhereRulesGaveUp: number;
  /** The model's choice was among the categories the rules also named. */
  agreed: number;
  avgConfidence: number | null;
};

export type BandRow = {
  band: string;
  rows: number;
  saidUnclassified: number;
  agreedWithRules: number;
};

export type DisagreementRow = {
  aiKey: string;
  rulesKey: string;
  rows: number;
};

export type RunReport = {
  runLabel: string;
  models: string[];
  slices: SliceRow[];
  bands: BandRow[];
  disagreements: DisagreementRow[];
  totals: {
    rows: number;
    predicted: number;
    failed: number;
    inputTokens: number;
    avgLatencyMs: number | null;
    firstAt: Date | null;
    lastAt: Date | null;
    withContext: number;
  };
};

/** One line per run, newest first, for choosing which to look at. */
export type RunLabelRow = {
  runLabel: string;
  rows: number;
  failed: number;
  lastAt: Date | null;
};

export async function runLabels(
  visibleChannels?: readonly ConversationChannel[],
): Promise<RunLabelRow[]> {
  const gate = channelGate(visibleChannels);

  const rows = await db.execute<{
    run_label: string;
    rows: string;
    failed: string;
    last_at: string | null;
  }>(sql`
    SELECT
      ai_category_runs.run_label AS run_label,
      count(*) AS rows,
      count(*) FILTER (WHERE ai_category_runs.error IS NOT NULL) AS failed,
      max(ai_category_runs.created_at) AS last_at
    FROM ai_category_runs
    JOIN conversations ON conversations.id = ai_category_runs.conversation_id
    WHERE true${gate}
    GROUP BY 1
    ORDER BY max(ai_category_runs.created_at) DESC
    LIMIT 50
  `);

  return rows.map((row) => ({
    runLabel: row.run_label,
    rows: Number(row.rows),
    failed: Number(row.failed),
    lastAt: row.last_at === null ? null : new Date(row.last_at),
  }));
}

export async function reportFor(
  runLabel: string,
  visibleChannels?: readonly ConversationChannel[],
): Promise<RunReport> {
  const gate = channelGate(visibleChannels);

  // `'meta.unclassified' = any(rules_keys)` and `predicted_key = any(rules_keys)`:
  // in both, what is inside the parentheses is an array *column*, which is the
  // one shape where `any()` in a raw fragment is correct (§6.46).
  const slices = await db.execute<{
    channel: string;
    script: string;
    rows: string;
    predicted: string;
    failed: string;
    rules_unclassified: string;
    named_where_rules_gave_up: string;
    agreed: string;
    avg_confidence: string | null;
  }>(sql`
    SELECT
      conversations.channel::text AS channel,
      CASE WHEN messages.body_text ~ '[؀-ۿ]' THEN 'arabic' ELSE 'other' END AS script,
      count(*) AS rows,
      count(*) FILTER (WHERE ai_category_runs.error IS NULL) AS predicted,
      count(*) FILTER (WHERE ai_category_runs.error IS NOT NULL) AS failed,
      count(*) FILTER (WHERE ${UNCLASSIFIED_KEY} = any(ai_category_runs.rules_keys))
        AS rules_unclassified,
      count(*) FILTER (
        WHERE ${UNCLASSIFIED_KEY} = any(ai_category_runs.rules_keys)
          AND ai_category_runs.predicted_key IS NOT NULL
          AND ai_category_runs.predicted_key <> ${UNCLASSIFIED_KEY}
      ) AS named_where_rules_gave_up,
      count(*) FILTER (WHERE ai_category_runs.predicted_key = any(ai_category_runs.rules_keys))
        AS agreed,
      avg(ai_category_runs.confidence) AS avg_confidence
    FROM ai_category_runs
    JOIN conversations ON conversations.id = ai_category_runs.conversation_id
    LEFT JOIN messages ON messages.id = ai_category_runs.message_id
    WHERE ai_category_runs.run_label = ${runLabel}${gate}
    GROUP BY 1, 2
    ORDER BY count(*) DESC
  `);

  const bands = await db.execute<{
    band: string;
    rows: string;
    said_unclassified: string;
    agreed_with_rules: string;
  }>(sql`
    SELECT
      CASE
        WHEN ai_category_runs.confidence IS NULL THEN 'unreported'
        WHEN ai_category_runs.confidence >= 0.9 THEN '0.90 and up'
        WHEN ai_category_runs.confidence >= 0.7 THEN '0.70 to 0.89'
        WHEN ai_category_runs.confidence >= 0.5 THEN '0.50 to 0.69'
        ELSE 'below 0.50'
      END AS band,
      count(*) AS rows,
      count(*) FILTER (WHERE ai_category_runs.predicted_key = ${UNCLASSIFIED_KEY})
        AS said_unclassified,
      count(*) FILTER (WHERE ai_category_runs.predicted_key = any(ai_category_runs.rules_keys))
        AS agreed_with_rules
    FROM ai_category_runs
    JOIN conversations ON conversations.id = ai_category_runs.conversation_id
    WHERE ai_category_runs.run_label = ${runLabel} AND ai_category_runs.error IS NULL${gate}
    GROUP BY 1
    -- Ordered by the band's own floor, not by its label: sorting the text puts
    -- "below 0.50" above "0.90 and up", which reads as the opposite of the point.
    ORDER BY min(ai_category_runs.confidence) DESC NULLS LAST
  `);

  const disagreements = await db.execute<{ ai_key: string; rules_key: string; rows: string }>(sql`
    SELECT
      coalesce(ai_category_runs.predicted_key, '(none)') AS ai_key,
      CASE
        WHEN ${UNCLASSIFIED_KEY} = any(ai_category_runs.rules_keys) THEN ${UNCLASSIFIED_KEY}
        ELSE coalesce(ai_category_runs.rules_keys[1], '(none)')
      END AS rules_key,
      count(*) AS rows
    FROM ai_category_runs
    JOIN conversations ON conversations.id = ai_category_runs.conversation_id
    WHERE ai_category_runs.run_label = ${runLabel}
      AND ai_category_runs.error IS NULL
      AND NOT (ai_category_runs.predicted_key = any(ai_category_runs.rules_keys))${gate}
    GROUP BY 1, 2
    ORDER BY count(*) DESC
    LIMIT 15
  `);

  const totals = await db.execute<{
    rows: string;
    predicted: string;
    failed: string;
    input_tokens: string | null;
    avg_latency_ms: string | null;
    first_at: string | null;
    last_at: string | null;
    with_context: string;
    models: string[] | null;
  }>(sql`
    SELECT
      count(*) AS rows,
      count(*) FILTER (WHERE ai_category_runs.error IS NULL) AS predicted,
      count(*) FILTER (WHERE ai_category_runs.error IS NOT NULL) AS failed,
      coalesce(sum(ai_category_runs.input_tokens), 0) AS input_tokens,
      avg(ai_category_runs.latency_ms) AS avg_latency_ms,
      min(ai_category_runs.created_at) AS first_at,
      max(ai_category_runs.created_at) AS last_at,
      count(*) FILTER (WHERE ai_category_runs.with_context) AS with_context,
      array_remove(array_agg(DISTINCT ai_category_runs.model), NULL) AS models
    FROM ai_category_runs
    JOIN conversations ON conversations.id = ai_category_runs.conversation_id
    WHERE ai_category_runs.run_label = ${runLabel}${gate}
  `);

  const total = totals[0];

  return {
    runLabel,
    models: total?.models ?? [],
    slices: slices.map((row) => ({
      channel: row.channel,
      script: row.script === 'arabic' ? 'arabic' : 'other',
      rows: Number(row.rows),
      predicted: Number(row.predicted),
      failed: Number(row.failed),
      rulesUnclassified: Number(row.rules_unclassified),
      namedWhereRulesGaveUp: Number(row.named_where_rules_gave_up),
      agreed: Number(row.agreed),
      avgConfidence: row.avg_confidence === null ? null : Number(row.avg_confidence),
    })),
    bands: bands.map((row) => ({
      band: row.band,
      rows: Number(row.rows),
      saidUnclassified: Number(row.said_unclassified),
      agreedWithRules: Number(row.agreed_with_rules),
    })),
    disagreements: disagreements.map((row) => ({
      aiKey: row.ai_key,
      rulesKey: row.rules_key,
      rows: Number(row.rows),
    })),
    totals: {
      rows: Number(total?.rows ?? 0),
      predicted: Number(total?.predicted ?? 0),
      failed: Number(total?.failed ?? 0),
      inputTokens: Number(total?.input_tokens ?? 0),
      avgLatencyMs: total?.avg_latency_ms == null ? null : Number(total.avg_latency_ms),
      firstAt: total?.first_at == null ? null : new Date(total.first_at),
      lastAt: total?.last_at == null ? null : new Date(total.last_at),
      withContext: Number(total?.with_context ?? 0),
    },
  };
}

/**
 * The report as the worker log prints it.
 *
 * It leads with what the window holds rather than with a result, for the reason
 * `/reports/categories` prints its own window (§6.54): a run over 640 messages
 * from one channel and a run over the whole archive produce the same shaped
 * output, and the number is only interpretable next to what it was measured on.
 */
export function formatReport(report: RunReport): string {
  const lines: string[] = [];
  const { totals } = report;

  lines.push(`run "${report.runLabel}" — ${totals.rows} messages measured`);
  lines.push(
    `  models: ${report.models.length > 0 ? report.models.join(', ') : '(none — nothing ran)'}`,
  );
  lines.push(
    `  predicted ${totals.predicted}, failed ${totals.failed}, ` +
      `${totals.inputTokens} input tokens, ` +
      `${totals.avgLatencyMs === null ? 'no' : Math.round(totals.avgLatencyMs) + 'ms avg'} latency`,
  );

  if (totals.rows === 0) {
    lines.push('  nothing to compare yet');
    return lines.join('\n');
  }

  lines.push('  per channel and script — rows / rules gave up / model named one / agreed:');
  for (const slice of report.slices) {
    lines.push(
      `    ${slice.channel}/${slice.script}: ${slice.rows} / ${slice.rulesUnclassified} / ` +
        `${slice.namedWhereRulesGaveUp} / ${slice.agreed}` +
        (slice.failed > 0 ? ` (${slice.failed} failed)` : ''),
    );
  }

  lines.push('  by confidence band — rows / said unclassified / agreed with rules:');
  for (const band of report.bands) {
    lines.push(
      `    ${band.band}: ${band.rows} / ${band.saidUnclassified} / ${band.agreedWithRules}`,
    );
  }

  if (report.disagreements.length > 0) {
    lines.push('  where they differ — model vs rules:');
    for (const row of report.disagreements) {
      lines.push(`    ${row.aiKey} vs ${row.rulesKey}: ${row.rows}`);
    }
  }

  return lines.join('\n');
}
