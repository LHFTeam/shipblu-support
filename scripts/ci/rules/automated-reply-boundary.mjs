import { fail, read, lineOf, stripComments } from '../lib.mjs';

/**
 * Software answering is not an agent answering.
 *
 * The first-response metric is meant to say how long a person waited for a
 * person. Calling the SLA hook from an automated sender, or moving the column
 * the unanswered queue reads, lets an acknowledgement satisfy every target and
 * makes the queue claim somebody handled a ticket nobody has opened.
 */
export function checkAutomatedRepliesDoNotCountAsAgentReplies() {
  const rule = 'automated-reply-boundary';
  const senders = ['lib/automations/index.ts', 'lib/auto-response/index.ts'];

  for (const file of senders) {
    const contents = stripComments(read(file));
    for (const match of contents.matchAll(/\bonAgentReply\s*\(/g)) {
      fail(
        rule,
        `${file}:${lineOf(contents, match.index)}`,
        'an automated sender must not stop an SLA response clock',
      );
    }
  }

  const outboundFile = 'lib/tickets/outbound.ts';
  const outbound = stripComments(read(outboundFile));
  for (const match of outbound.matchAll(/\b(lastAgentMessageAt|firstRespondedAt)\s*:/g)) {
    fail(
      rule,
      `${outboundFile}:${lineOf(outbound, match.index)}`,
      'automated delivery must leave the ticket in the unanswered queue',
    );
  }

  // `is_first_response_overdue` answers for the SLA, and only `firstRespondedAt`
  // does that. Reading the auto-reply stamp into it silences every rule sharing
  // the condition, including the escalations that send the customer nothing —
  // the loop belongs to the sender, and `alreadyReplied` guards it there.
  const factsFile = 'lib/rules/facts.ts';
  const facts = stripComments(read(factsFile));
  for (const match of facts.matchAll(
    /is_first_response_overdue[\s\S]{0,120}?firstAutoRepliedAt/g,
  )) {
    fail(
      rule,
      `${factsFile}:${lineOf(facts, match.index)}`,
      'the overdue flag answers for the SLA, not for whether software replied',
    );
  }

  // The other half: `firstAutoRepliedAt` exists so the rule engine can tell an
  // acknowledgement already went out. A report or the breach sweep reading it
  // would put the automation's latency back into the number this whole seam
  // exists to keep honest.
  for (const file of [
    'lib/reports/rollup.ts',
    'lib/reports/live.ts',
    'worker/handlers/sla-sweep.ts',
  ]) {
    const contents = stripComments(read(file));
    for (const match of contents.matchAll(/\b(firstAutoRepliedAt|first_auto_replied_at)\b/g)) {
      fail(
        rule,
        `${file}:${lineOf(contents, match.index)}`,
        'an automated reply is not a first response and must not reach a metric',
      );
    }
  }
}
