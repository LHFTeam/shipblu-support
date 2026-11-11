import type { StaticImageData } from 'next/image';
import type { TopicArt } from '@/lib/kb/art';
import type { Locale } from '@/lib/kb/locale';
import account from './art/account.webp';
import claims from './art/claims.webp';
import paymentsAr from './art/payments-ar.webp';
import paymentsEn from './art/payments-en.webp';
import questions from './art/questions.webp';
import returns from './art/returns.webp';
import shipping from './art/shipping.webp';
import store from './art/store.webp';
import support from './art/support.webp';
import trackingPin from './art/tracking-pin.webp';

/**
 * The help centre's illustrations, from the help-centre design.
 *
 * Imported rather than served from `public/`: the help centre answers on its
 * own host, where `proxy.ts` rewrites every path but Next's own into `/help/…`,
 * so a file at `/art/x.webp` would be rewritten out of existence. A static
 * import lands under `/_next/static/media` with a content hash in its name —
 * the path the proxy passes through on every host, cached for good — and hands
 * back the image's own width and height, so the page reserves its space before
 * the bytes arrive and nothing jumps.
 *
 * A plain `<img>` rather than `next/image`. These are 19–42 KB, and most of the
 * redrawn ones are supplied at two to three times the size they are drawn at —
 * 600px for a topic drawing the folder pages draw at 260px, 300px for the
 * tracking parcel's 150px — so they stay sharp on a 2x screen, and the
 * optimiser would spend a request and a CPU cycle on Render to save a few KB.
 *
 * `.kb-art-fade` is a radial mask, so whatever a file carries at its edges is
 * faded out. A file drawn on a tile that reaches its edges therefore needs a
 * transparent margin around the tile, or the fade takes the tile's corners and
 * whatever stands in them: the questions drawing's first 600px export arrived
 * opaque to its edges, with a pedestal at one and the magnifier at the other,
 * and was framed with its tile at 74% of the file. Its current export (uploaded
 * straight to `main` on 2026-11-06) is the scene alone on a transparent
 * background, nothing but the tip of its swoosh at an edge, so it needs no
 * margin and sits in the same 600px frame as the other topic drawings.
 *
 * Every one is decoration: the words beside it say everything it does, so it
 * carries an empty `alt` and is hidden from assistive technology.
 */

/** The drawings with no words in them, which both languages share. */
const WORDLESS: Omit<Record<TopicArt, StaticImageData>, 'payments'> = {
  account,
  claims,
  questions,
  returns,
  shipping,
  store,
};

/**
 * Each language's set. The payments drawing is lettered — its balance card
 * reads «رصيد متاح» — so the English page draws its own export, which reads
 * "Available balance", rather than Arabic words beside an English title. Typed
 * per language, so a third locale does not compile until it has a full set.
 */
const TOPIC_IMAGES: Record<Locale, Record<TopicArt, StaticImageData>> = {
  ar: { ...WORDLESS, payments: paymentsAr },
  en: { ...WORDLESS, payments: paymentsEn },
};

function Art({
  image,
  className = '',
  priority = false,
}: {
  image: StaticImageData;
  className?: string;
  /** The band's art is above the fold; everything else may wait for a scroll. */
  priority?: boolean;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a few KB drawn at its exported size; see the module header
    <img
      src={image.src}
      width={image.width}
      height={image.height}
      alt=""
      aria-hidden
      decoding="async"
      loading={priority ? 'eager' : 'lazy'}
      className={`pointer-events-none h-auto select-none ${className}`}
    />
  );
}

/**
 * The drawing for a topic, already matched by `topicArt` — or nothing, for a
 * name it did not recognise — in the page's language. The caller resolves the
 * match once and lays out around its absence with the same answer it hands here.
 */
export function TopicArtImage({
  locale,
  art,
  className = '',
  priority = false,
}: {
  locale: Locale;
  art: TopicArt | null;
  className?: string;
  priority?: boolean;
}) {
  if (!art) return null;
  return <Art image={TOPIC_IMAGES[locale][art]} className={className} priority={priority} />;
}

/** The parcel and pin that perches on the front page's tracking card. */
export function TrackingArt({ className = '' }: { className?: string }) {
  return <Art image={trackingPin} className={className} priority />;
}

/** The headset and chat bubble on every "still need help?" band. */
export function SupportArt({ className = '' }: { className?: string }) {
  return <Art image={support} className={className} />;
}
