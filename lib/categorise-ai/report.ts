import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { UNCLASSIFIED_KEY } from '@/lib/categorise/taxonomy';

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
 * `count(*)` is a bigint, which postgres.js hands over as a string, so everything
 * is coerced on the way out rather than at each call site.
 */

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
  };
};

export async function reportFor(runLabel: string): Promise<RunReport> {
  // `'meta.unclassified' = any(r.rules_keys)` and `r.predicted_key = any(r.rules_keys)`:
  // in both, what is inside the parentheses is an array *column*, which is the
  // one shape where `any()` in a raw fragment is correct (§6.46). A JS array
  // there would reach Postgres as a row constructor and be refused.
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
      c.channel::text AS channel,
      CASE WHEN m.body_text ~ '[؀-ۿ]' THEN 'arabic' ELSE 'other' END AS script,
      count(*) AS rows,
      count(*) FILTER (WHERE r.error IS NULL) AS predicted,
      count(*) FILTER (WHERE r.error IS NOT NULL) AS failed,
      count(*) FILTER (WHERE ${UNCLASSIFIED_KEY} = any(r.rules_keys)) AS rules_unclassified,
      count(*) FILTER (
        WHERE ${UNCLASSIFIED_KEY} = any(r.rules_keys)
          AND r.predicted_key IS NOT NULL
          AND r.predicted_key <> ${UNCLASSIFIED_KEY}
      ) AS named_where_rules_gave_up,
      count(*) FILTER (WHERE r.predicted_key = any(r.rules_keys)) AS agreed,
      avg(r.confidence) AS avg_confidence
    FROM ai_category_runs r
    JOIN conversations c ON c.id = r.conversation_id
    LEFT JOIN messages m ON m.id = r.message_id
    WHERE r.run_label = ${runLabel}
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
        WHEN r.confidence IS NULL THEN 'unreported'
        WHEN r.confidence >= 0.9 THEN '0.90 and up'
        WHEN r.confidence >= 0.7 THEN '0.70 to 0.89'
        WHEN r.confidence >= 0.5 THEN '0.50 to 0.69'
        ELSE 'below 0.50'
      END AS band,
      count(*) AS rows,
      count(*) FILTER (WHERE r.predicted_key = ${UNCLASSIFIED_KEY}) AS said_unclassified,
      count(*) FILTER (WHERE r.predicted_key = any(r.rules_keys)) AS agreed_with_rules
    FROM ai_category_runs r
    WHERE r.run_label = ${runLabel} AND r.error IS NULL
    GROUP BY 1
    -- Ordered by the band's own floor, not by its label: sorting the text puts
    -- "below 0.50" above "0.90 and up", which reads as the opposite of the point.
    ORDER BY min(r.confidence) DESC NULLS LAST
  `);

  const disagreements = await db.execute<{ ai_key: string; rules_key: string; rows: string }>(sql`
    SELECT
      coalesce(r.predicted_key, '(none)') AS ai_key,
      CASE
        WHEN ${UNCLASSIFIED_KEY} = any(r.rules_keys) THEN ${UNCLASSIFIED_KEY}
        ELSE coalesce(r.rules_keys[1], '(none)')
      END AS rules_key,
      count(*) AS rows
    FROM ai_category_runs r
    WHERE r.run_label = ${runLabel}
      AND r.error IS NULL
      AND NOT (r.predicted_key = any(r.rules_keys))
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
    models: string[] | null;
  }>(sql`
    SELECT
      count(*) AS rows,
      count(*) FILTER (WHERE r.error IS NULL) AS predicted,
      count(*) FILTER (WHERE r.error IS NOT NULL) AS failed,
      coalesce(sum(r.input_tokens), 0) AS input_tokens,
      avg(r.latency_ms) AS avg_latency_ms,
      array_remove(array_agg(DISTINCT r.model), NULL) AS models
    FROM ai_category_runs r
    WHERE r.run_label = ${runLabel}
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
