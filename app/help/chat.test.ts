import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatWidget, hideChat, showChat } from './chat';

/**
 * `ChatWidget` with React's effect hooks recorded rather than run, so a test
 * can say which kind of effect each one is, what it depends on, and what its
 * cleanup does — the three things the design rests on, and none of which a
 * test of `showChat` and `hideChat` alone can see.
 */
const hooks = vi.hoisted(() => ({
  params: {} as { locale?: string },
  effects: [] as {
    kind: 'layout' | 'passive';
    run: () => void | (() => void);
    deps?: readonly unknown[];
  }[],
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
    hooks.effects.push({ kind: 'passive', run, deps });
  },
  useLayoutEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
    hooks.effects.push({ kind: 'layout', run, deps });
  },
}));

vi.mock('next/navigation', () => ({ useParams: () => hooks.params }));

/**
 * The help centre's half of the chat's lifetime: when the snippet is loaded,
 * and when it is taken back down.
 *
 * Where the launcher-in-the-console bug lived (`docs/PROJECT-STATE.md` §6.78),
 * so the cases are the orderings a navigation can produce rather than the happy
 * path: leaving while the file is still on its way, coming back before it
 * lands, a file that never comes.
 */

type Listener = () => void;

class FakeScript {
  id = '';
  src = '';
  async = false;
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Listener[]>();
  removed = false;

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  remove() {
    this.removed = true;
    page.tags = page.tags.filter((tag) => tag !== this);
  }

  /** The browser finishing with it: the snippet has run, or the fetch failed. */
  fire(type: 'load' | 'error') {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

type Api = { setLocale: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };

const page = {
  tags: [] as FakeScript[],
  window: {} as { shipbluChat?: Api },
};

/** What running the snippet does to the page, as far as this module can see. */
function snippetRuns(): Api {
  const api: Api = {
    setLocale: vi.fn(),
    destroy: vi.fn(() => {
      page.tags.forEach((tag) => tag.remove());
      delete page.window.shipbluChat;
    }),
  };
  page.window.shipbluChat = api;
  return api;
}

beforeEach(() => {
  page.tags = [];
  page.window = {};
  vi.stubGlobal('window', page.window);
  vi.stubGlobal('document', {
    getElementById: (id: string) => page.tags.find((tag) => tag.id === id) ?? null,
    createElement: () => new FakeScript(),
    body: { appendChild: (tag: FakeScript) => page.tags.push(tag) },
  });
  // Module state from the previous test: nobody is on a help page.
  hideChat();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the help centre chat', () => {
  it('loads the snippet once, under its own cache key, and hands a language switch to it', () => {
    showChat('ar');
    expect(page.tags).toHaveLength(1);
    expect(page.tags[0]!.src).toBe('/widget/embed.js?v=2');
    expect(page.tags[0]!.dataset.locale).toBe('ar');

    // Switched before the file arrived: the attribute is what it will read.
    showChat('en');
    expect(page.tags).toHaveLength(1);
    expect(page.tags[0]!.dataset.locale).toBe('en');

    // Switched after: the snippet is told.
    const api = snippetRuns();
    page.tags[0]!.fire('load');
    showChat('ar');
    expect(api.setLocale).toHaveBeenCalledWith('ar');
    expect(api.destroy).not.toHaveBeenCalled();
  });

  it('takes the chat down when the reader leaves', () => {
    showChat('ar');
    const api = snippetRuns();
    page.tags[0]!.fire('load');

    hideChat();

    expect(api.destroy).toHaveBeenCalledOnce();
    expect(page.tags).toEqual([]);
  });

  it('takes down a snippet that lands after the reader has left', () => {
    showChat('ar');
    const tag = page.tags[0]!;

    hideChat();
    // Not removed: that would not stop it running.
    expect(page.tags).toEqual([tag]);

    const api = snippetRuns();
    tag.fire('load');

    expect(api.destroy).toHaveBeenCalledOnce();
  });

  it('keeps a snippet that lands after the reader came back', () => {
    showChat('ar');
    const tag = page.tags[0]!;

    hideChat();
    showChat('en');
    expect(page.tags).toEqual([tag]);
    expect(tag.dataset.locale).toBe('en');

    const api = snippetRuns();
    tag.fire('load');

    expect(api.destroy).not.toHaveBeenCalled();
  });

  /**
   * Listened for once, when the tag is made. A listener per departure would pile
   * up on a tag whose file never arrives, one for every round trip between the
   * help centre and the console.
   */
  it('does not add listeners each time the reader leaves and comes back', () => {
    showChat('ar');
    for (let trip = 0; trip < 5; trip++) {
      hideChat();
      showChat('ar');
    }

    const tag = page.tags[0]!;
    expect(tag.listeners.get('load')).toHaveLength(1);
    expect(tag.listeners.get('error')).toHaveLength(1);
  });

  it('tries again on the next visit when the file never came', () => {
    showChat('ar');
    const first = page.tags[0]!;

    first.fire('error');
    expect(first.removed).toBe(true);

    showChat('ar');
    expect(page.tags).toHaveLength(1);
    expect(page.tags[0]).not.toBe(first);
  });
});

describe('ChatWidget', () => {
  function render(locale?: string) {
    hooks.params = locale === undefined ? {} : { locale };
    hooks.effects = [];
    ChatWidget();
    return {
      layout: hooks.effects.filter((effect) => effect.kind === 'layout'),
      passive: hooks.effects.filter((effect) => effect.kind === 'passive'),
    };
  }

  /**
   * The locale effect re-runs on every switch, so a cleanup on it would take
   * the chat down each time the reader changed language — an open conversation
   * closed by the language link.
   */
  it('loads the chat for the locale in the route, and a language switch takes nothing down', () => {
    const { passive } = render('ar');

    expect(passive).toHaveLength(1);
    expect(passive[0]!.deps).toEqual(['ar']);
    expect(passive[0]!.run()).toBeUndefined();
    expect(page.tags).toHaveLength(1);
    expect(page.tags[0]!.dataset.locale).toBe('ar');
  });

  /**
   * A layout effect, so the chat is gone in the commit that draws the next
   * page. A passive one runs after the browser has painted, and the console
   * showed a frame of the launcher over the inbox in most runs.
   */
  it('takes the chat down when it unmounts, before the next page is painted', () => {
    const { layout, passive } = render('ar');
    passive[0]!.run();
    const api = snippetRuns();
    page.tags[0]!.fire('load');

    expect(layout).toHaveLength(1);
    expect(layout[0]!.deps).toEqual([]);

    const cleanup = layout[0]!.run();
    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();

    expect(api.destroy).toHaveBeenCalledOnce();
  });

  it('loads nothing for a route with no locale in it', () => {
    const { passive } = render();
    passive[0]!.run();

    expect(page.tags).toEqual([]);
  });
});

/**
 * Taking the chat down on unmount is only right because `ChatWidget` is
 * rendered above the locale segment. The `[locale]` layout is replaced on every
 * language switch, so a `ChatWidget` moved into it would unmount — and close an
 * open conversation — each time the reader changed language, with nothing else
 * to say so.
 */
describe('where ChatWidget is rendered', () => {
  const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

  it('is the help layout, above the locale segment', () => {
    expect(source('app/help/layout.tsx')).toMatch(/<ChatWidget\b/);
    expect(source('app/help/[locale]/layout.tsx')).not.toMatch(/ChatWidget/);
  });
});
