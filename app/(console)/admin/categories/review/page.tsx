import Link from 'next/link';
import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { reviewQueue, ruleScores } from '@/lib/categorise/queries';
import { direction } from '@/lib/kb/locale';
import { detectLocale } from '@/lib/kb/language';
import { CONVERSATION_CHANNELS, hiddenChannels } from '@/lib/tickets/channel-policy';
import { ReviewControls } from './controls';

export const dynamic = 'force-dynamic';

/**
 * The categories the detector is unsure about, and how each rule is doing.
 *
 * Two halves that answer different questions. The queue is the work: every
 * suggestion waiting on one click. The table underneath is why the work is worth
 * doing — a rule with a high rejection count is one to narrow, and a rule with
 * nothing but unreviewed rows is one nobody has checked yet.
 *
 * Ordered best-evidence-first rather than newest-first. The suggestions most
 * likely to be right are the cheapest to confirm, and clearing those fastest is
 * what stops this becoming the screen nobody opens.
 */
export default async function CategoryReviewPage() {
  const agent = await requirePermission('admin.categories');

  /*
   * The visibility gate, and the most important line on this page.
   *
   * This queue joins `conversations`, so without it the page is a list of
   * tickets served to anybody holding `admin.categories` — including the bot
   * transcripts that `ticket.view.bot` exists to keep out. Derived from the same
   * helper the inbox uses rather than a rule of its own.
   */
  const hidden = new Set<string>(hiddenChannels(agent));
  const visibleChannels = CONVERSATION_CHANNELS.filter((channel) => !hidden.has(channel));

  const [queue, scores] = await Promise.all([reviewQueue({ visibleChannels }), ruleScores()]);

  const canDecide = can(agent, 'ticket.categorise');

  return (
    <>
      <PageHeader
        title="Category review"
        description="Suggestions the rules were not confident enough to apply on their own. Confirming one says the rule was right; rejecting it stops that rule suggesting the same thing on that ticket again."
      />

      {queue.length === 0 ? (
        <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm opacity-70">
          Nothing waiting. Either every suggestion has been answered, or no tickets have arrived on
          a channel you can see.
        </p>
      ) : (
        <Table
          head={[
            'Ticket',
            'Suggested category',
            <>
              Evidence{' '}
              <InfoTip label="Evidence">
                Which rule matched, and how directly. A whole message that reads as a known phrase
                scores highest; a single keyword inside a longer sentence scores lowest and is why
                most of these are here rather than applied outright. It is a grade of evidence, not
                a probability — nothing here is claiming a percentage chance of being right.
              </InfoTip>
            </>,
            'What the customer wrote',
            '',
          ]}
        >
          {queue.map((row) => {
            // Per row, not per page. The excerpt is the customer's own words and
            // is usually Arabic even where the console is English; an Arabic
            // sentence in a left-to-right block puts its punctuation on the
            // wrong end and reads as though it has been corrupted.
            const excerptLocale = row.excerpt ? detectLocale(row.excerpt) : 'en';

            return (
              <Row key={`${row.conversationId}:${row.categoryId}`}>
                <Cell>
                  <Link href={`/inbox/${row.number}`} className="font-medium hover:underline">
                    #{row.number}
                  </Link>
                  <p className="opacity-60">
                    <Badge>{row.channel}</Badge>
                  </p>
                </Cell>
                <Cell>
                  <span className="font-medium">{row.labelEn}</span>
                  <p className="text-xs opacity-50">{row.key}</p>
                </Cell>
                <Cell className="text-xs">
                  <p className="opacity-70">{row.confidence.toFixed(2)}</p>
                  <p className="opacity-50">{row.ruleKey ?? 'no rule matched'}</p>
                </Cell>
                <Cell className="max-w-xs">
                  {row.excerpt ? (
                    <p
                      dir={direction(excerptLocale)}
                      lang={excerptLocale}
                      className="truncate text-xs opacity-70"
                    >
                      {row.excerpt}
                    </p>
                  ) : (
                    <p className="text-xs opacity-40">the message is gone</p>
                  )}
                </Cell>
                <Cell>
                  {canDecide ? (
                    <ReviewControls
                      conversationId={row.conversationId}
                      categoryId={row.categoryId}
                      label={row.labelEn}
                    />
                  ) : null}
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}

      <section className="mt-8">
        <h2 className="mb-1 text-sm font-medium">How the rules are doing</h2>
        <p className="mb-3 max-w-2xl text-sm opacity-70">
          Every assignment keeps the rule that made it, and a rejected one is kept rather than
          deleted — so this needs no extra bookkeeping. A rule with rejections outnumbering
          agreements is matching something it should not; one with nothing but unreviewed rows is
          one nobody has checked. Turn a bad rule off with <code>CATEGORISE_DISABLED_RULES</code>{' '}
          rather than waiting for a deploy.
        </p>

        {scores.length === 0 ? (
          <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm opacity-70">
            No rule has fired yet.
          </p>
        ) : (
          <Table head={['Rule', 'Agreed', 'Rejected', 'Unreviewed']}>
            {scores.map((score) => (
              <Row key={score.ruleKey}>
                <Cell>
                  <code className="text-xs">{score.ruleKey}</code>
                </Cell>
                <Cell>{score.agreed}</Cell>
                <Cell>
                  {score.rejected > score.agreed && score.rejected > 0 ? (
                    <Badge tone="warning">{score.rejected}</Badge>
                  ) : (
                    score.rejected
                  )}
                </Cell>
                <Cell className="opacity-60">{score.unreviewed}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </section>
    </>
  );
}
