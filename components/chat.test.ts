// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChatBubble, ChatReaction } from './chat';

/**
 * A reaction arriving on a message must not remount what the message shows.
 *
 * `LiveUpdates` re-renders the thread whenever anything on the ticket moves,
 * and a reaction is often the thing that moved: the customer's 👍 lands on a
 * voice note an agent is playing, or on a photo they have opened. The bubble
 * once drew its reactions' wrapper only when there were reactions, so the first
 * one changed the tree above the body and React rebuilt it — the audio stopped
 * and the photo closed. `.ts` with `createElement`, as `use-action-form.test.ts`
 * explains.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('ChatBubble', () => {
  it('keeps its body mounted as reactions come and go', () => {
    let mounts = 0;
    function Body() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return createElement('p', null, 'voice note');
    }

    const render = (reactions?: ReturnType<typeof createElement>) =>
      createElement(
        'ol',
        null,
        createElement(ChatBubble, { from: 'in', reactions }, createElement(Body)),
      );

    root = createRoot(document.createElement('div'));
    act(() => root!.render(render()));
    act(() => root!.render(render(createElement(ChatReaction, { emoji: '👍' }))));
    act(() => root!.render(render()));

    expect(mounts).toBe(1);
  });
});
