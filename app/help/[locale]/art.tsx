import type { StaticImageData } from 'next/image';
import { topicArt, type TopicArt } from '@/lib/kb/art';
import claims from './art/claims.webp';
import payments from './art/payments.webp';
import pickups from './art/pickups.webp';
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
 * A plain `<img>` rather than `next/image`. These are 5–32 KB drawn at the size
 * they were exported at, so the optimiser would spend a request and a CPU cycle
 * on Render to hand back what it was given.
 *
 * Every one is decoration: the words beside it say everything it does, so it
 * carries an empty `alt` and is hidden from assistive technology.
 */

const TOPIC_IMAGES: Record<TopicArt, StaticImageData> = {
  claims,
  payments,
  pickups,
  returns,
  shipping,
  store,
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
 * The drawing for a category or folder, matched on its own name — or nothing,
 * for a name `topicArt` does not recognise. Callers lay out around its absence.
 */
export function TopicArtImage({
  name,
  slug,
  className = '',
  priority = false,
}: {
  name: string;
  slug?: string;
  className?: string;
  priority?: boolean;
}) {
  const art = topicArt(name, slug);
  if (!art) return null;
  return <Art image={TOPIC_IMAGES[art]} className={className} priority={priority} />;
}

/** Whether `TopicArtImage` would draw anything, for a layout that changes shape. */
export function hasTopicArt(name: string, slug?: string): boolean {
  return topicArt(name, slug) !== null;
}

/** The parcel and pin that perches on the front page's tracking card. */
export function TrackingArt({ className = '' }: { className?: string }) {
  return <Art image={trackingPin} className={className} priority />;
}

/** The headset and chat bubble on every "still need help?" band. */
export function SupportArt({ className = '' }: { className?: string }) {
  return <Art image={support} className={className} />;
}
