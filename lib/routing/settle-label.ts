/**
 * The label a decision made at the window's end carries
 * (`routing_decisions.decided_by_label`), written by `settleRouting`.
 *
 * A leaf of its own so that `/reports/routing`, which only reads the label,
 * does not load the router — assignment, the SLA, the rules engine and the
 * queue — to name one string, and nothing the router imports can come back
 * round through the report.
 */
export const SETTLE_ACTOR = 'settle_routing';
