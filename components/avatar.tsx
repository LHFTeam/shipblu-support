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
  const [failed, setFailed] = useState(false);
  const showImage = hasAvatar && !failed;

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--muted)] text-[var(--muted-foreground)] select-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      <span className="font-medium">{initials(name)}</span>
      {showImage ? (
        // Not next/image: the source is a redirect to a signed URL on a host
        // that changes per request, which the optimiser cannot cache and would
        // only add a hop to.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/contacts/${contactId}/avatar`}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}
