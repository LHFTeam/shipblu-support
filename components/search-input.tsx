'use client';

import type { ComponentProps, KeyboardEvent } from 'react';
import { Input } from './ui';

/**
 * A text box that searches or filters something on the page, for wherever one
 * renders inside a form it is not a field of.
 *
 * Enter in a single-line input is the browser's implicit submission of the form
 * that owns it. The knowledge panel renders inside the reply form, and Enter in
 * its search box sent the agent's half-written reply to the customer. So this
 * box owns no form at all: a `form` attribute names the form a control belongs
 * to, and the empty string names none, which leaves its form owner null. That
 * holds whatever the key event looks like, and for the next box placed inside a
 * form, without a keydown guard somebody has to remember to write. It is the
 * same move `Button` makes by defaulting to `type="button"`: the safe case is
 * the one you get by not thinking about it.
 *
 * Its own client module rather than a variant in `ui.tsx`, because that file
 * is rendered from server components too and an event handler there would fail
 * the render.
 *
 * Enter dismisses the box instead. The search already runs as the agent types,
 * so Enter has nothing of its own to do, and on a phone it is the keyboard's
 * search key: blurring is what puts the keyboard away so the results under it
 * can be read.
 */
export function SearchInput(props: Omit<ComponentProps<typeof Input>, 'form' | 'onKeyDown'>) {
  return <Input enterKeyHint="search" {...props} form="" onKeyDown={blurOnEnter} />;
}

/**
 * Not on the Enter that confirms an input-method conversion, which on macOS
 * arrives as `key === 'Enter'` too: Chrome marks it `isComposing`, and Safari
 * sends it just after composition ends with only `keyCode` 229 to say so.
 * Blurring there would throw the agent out of the box mid-query. A phone's
 * search key arrives after its composition has finished, as a plain Enter.
 */
function blurOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return;
  event.currentTarget.blur();
}
