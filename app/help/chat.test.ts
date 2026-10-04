import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideChat, showChat } from './chat';

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
