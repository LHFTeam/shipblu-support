import { db } from '@/db/client';
import { shipmentPhrases } from '@/db/schema';
import { Cell, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requirePermission } from '@/lib/auth/guard';
import { PHRASE_GROUPS } from '@/lib/shipments/status';
import { PhraseEditor } from './forms';

export const dynamic = 'force-dynamic';

/**
 * The Arabic wording the public tracking page shows.
 *
 * This screen exists because the wording is not ours to be certain about.
 * Whether a parcel that failed a delivery attempt reads as `محاولة تسليم غير
 * ناجحة` or as something else is a question about what ShipBlu's own SMS and app
 * already say to the same customer about the same parcel — and getting that
 * wrong means the help centre and the SMS disagree, which is the exact failure
 * that kept the page in English for as long as it was.
 *
 * Every phrase has a default, so this table is a list of *what can be changed*
 * rather than of what has been. A screen that only listed the overrides would be
 * a list of whatever somebody already edited, which is no way to find the phrase
 * you are looking for.
 *
 * English is not editable and is not shown as a column. An English reader sees
 * the status the platform sent, in the platform's own words; a box that let an
 * admin restate ShipBlu's English in ours would quietly undo the one property
 * `/en/track` exists to have.
 */
const GROUPS = {
  status: {
    title: 'Delivery statuses',
    description:
      'What the badge and each row of the history say. The platform sends these in English; this is what an Arabic reader sees instead.',
  },
  reason: {
    title: 'Courier reasons',
    description:
      'The reason code in front of a tracking comment — the part before the dash. Whatever the courier typed after it is their own words about one parcel and is never translated.',
  },
} as const;

export default async function TrackingWordingPage() {
  await requirePermission('admin.fields');

  const saved = await db
    .select({ key: shipmentPhrases.key, ar: shipmentPhrases.ar })
    .from(shipmentPhrases);
  const overrides = new Map(saved.map((row) => [row.key, row.ar]));

  return (
    <>
      <PageHeader
        title="Tracking wording"
        description="What the Arabic tracking page calls each delivery status. Leave a box empty to use the wording ShipBlu Support ships with."
      />

      {PHRASE_GROUPS.map((group) => (
        <section key={group.kind} className="mb-8">
          <h2 className="text-sm font-semibold">{GROUPS[group.kind].title}</h2>
          <p className="mt-1 mb-3 text-xs text-[var(--muted-foreground)]">
            {GROUPS[group.kind].description}
          </p>

          <Table
            head={[
              <>
                Recognised from{' '}
                <InfoTip label="Recognised from">
                  The words a status has to contain for this phrase to be used. They come from the
                  shipping platform&rsquo;s own vocabulary and are not editable here — a status
                  matching none of them is shown exactly as the platform sent it, in English, rather
                  than guessed at.
                </InfoTip>
              </>,
              'Shown to Arabic readers',
              '',
            ]}
          >
            {group.rows.map((phrase) => (
              <Row key={phrase.key}>
                <Cell>
                  <span className="font-medium">{phrase.keywords[0]}</span>
                  {phrase.keywords.length > 1 ? (
                    <span className="ms-2 text-xs text-[var(--muted-foreground)]">
                      +{phrase.keywords.length - 1} more
                    </span>
                  ) : null}
                </Cell>
                <Cell className="w-full">
                  <PhraseEditor
                    phraseKey={phrase.key}
                    fallback={phrase.ar}
                    saved={overrides.get(phrase.key) ?? ''}
                  />
                </Cell>
                <Cell className="text-end text-xs text-[var(--muted-foreground)]">
                  {overrides.has(phrase.key) ? 'edited' : 'default'}
                </Cell>
              </Row>
            ))}
          </Table>
        </section>
      ))}
    </>
  );
}
