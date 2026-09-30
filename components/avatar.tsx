'use client';

import { useState } from 'react';
import { initials } from './initials';

/**
 * A customer's face, or their initials when we have no picture.
 *
 * Initials are the default rather than the fallback: most contacts will never
 * have a picture — email and web chat have none to give — so a component that
 * treated the image as the normal case would leave the console full of holes.
 *
 * The image is layered *over* the initials rather than replacing them, and hides
 * itself if it fails to load. That covers the two ways the URL can stop working
 * without anything being broken: an agent without `contact.view` gets a 404 from
 * the avatar route, and a signed URL cached by the browser eventually expires.
 * Either way the tile keeps its shape and reads as a person, not as an error.
 */
export function Avatar({
  name,
  contactId,
  hasAvatar,
  size = 28,
}: {
  name: string | null;
  contactId: string;
  /** Whether `contacts.avatar_path` is set. Saves a request that would 404. */
  hasAvatar: boolean;
  size?: number;
}) {
  return (
    <Tile
      name={name}
      src={hasAvatar ? `/api/contacts/${contactId}/avatar` : null}
      size={size}
      tone="bg-[var(--muted)] text-[var(--muted-foreground)]"
    />
  );
}

/**
 * An agent's picture, or their initials.
 *
 * Solid brand blue with white letters: the circle the console header already
 * draws for the signed-in agent, so an agent reads the same everywhere. Solid
 * because every badge on an inbox row — status, channel, window — is a pale
 * tint, and a pale tile in any hue collides with one of them: pink is the
 * Instagram badge, violet the customer bot, blue Facebook, slate the portal,
 * and emerald, amber and red are statuses. One colour for every agent rather
 * than one each for the same reason, since the hues left after those are too
 * few to tell a team apart.
 *
 * `agents.avatar_url` is a URL rather than a storage path — nothing in the app
 * uploads one — so it is used as given, and the same layering as `Avatar` means
 * one that has gone stale falls back to the initials rather than a broken image.
 */
export function AgentAvatar({
  name,
  avatarUrl,
  size = 22,
}: {
  name: string | null;
  avatarUrl: string | null;
  size?: number;
}) {
  return <Tile name={name} src={avatarUrl} size={size} tone="bg-brand-600 text-white" />;
}

/**
 * The shared tile. `aria-hidden` because a picture of somebody says nothing a
 * screen reader can use: a caller that shows the tile without the name beside
 * it names the person in text of its own.
 */
function Tile({
  name,
  src,
  size,
  tone,
}: {
  name: string | null;
  src: string | null;
  size: number;
  tone: string;
}) {
  /*
    Which source failed, not whether one did.

    A bare boolean survives a prop change — React reuses the instance when the
    header re-renders after a profile job lands, or when any list swaps the
    person at the same tree position — and an earlier 404 would then suppress a
    different person's picture that was never requested. The tile would read as
    "this person has no photo" when nothing had asked for one.
  */
  const [failedFor, setFailedFor] = useState<string | null>(null);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full leading-none select-none ${tone}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      <span className="font-medium">{initials(name)}</span>
      {/* Truthiness, not `!== null`: an `avatar_url` cleared to '' is not a
          picture, and `<img src="">` asks the browser for the page itself. */}
      {src && failedFor !== src ? (
        // Not next/image: a contact's source is a redirect to a signed URL on a
        // host that changes per request, which the optimiser cannot cache and
        // would only add a hop to — and an agent's is on whatever host it names,
        // which the optimiser would need allowlisting for.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailedFor(src)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}
