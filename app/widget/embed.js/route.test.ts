import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { HOST_SAYS, SOURCE, WIDGET_SAYS } from '@/lib/widget/protocol';
import { GET } from './route';

/**
 * The snippet is JavaScript written inside a template literal, which is the one
 * shape in this repo where a syntax error is invisible to every other check:
 * `tsc` type-checks the string, `eslint` lints the string, and the file it
 * generates is never parsed until a browser somewhere on shipblu.com tries to.
 * One unescaped backtick or `${` ends the literal early, and what ships is a
 * truncated program that throws on load — on every page carrying the tag, at
 * once, with no launcher and nothing in the request logs to say why.
 *
 * So: parse what is actually served, with the parser that will have to.
 */
describe('the embed snippet', () => {
  it('parses as JavaScript', async () => {
    const body = await (await GET()).text();

    const file = join(mkdtempSync(join(tmpdir(), 'shipblu-embed-')), 'embed.js');
    writeFileSync(file, body);

    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
  });

  /**
   * Every name a host page is documented to call, checked against what the
   * object literal actually assigns. `docs/embedding-the-widget.md` is a
   * contract somebody else's deployed code implements: a method quietly renamed
   * here fails in their console, not ours.
   */
  it('exposes the whole host API', async () => {
    const body = await (await GET()).text();

    const methods = [
      'identify',
      'clear',
      'setLocale',
      'compose',
      'open',
      'close',
      'toggle',
      'destroy',
    ];
    for (const method of methods) {
      expect(body).toMatch(new RegExp(`^\\s*${method}:`, 'm'));
    }
  });

  /**
   * The snippet speaks the frame's protocol by name, and a name that is not in
   * `lib/widget/protocol.ts` reads as `undefined` in the browser — no error,
   * just a message the frame ignores. So every name the served script reaches
   * for has to be declared, and no quoted wire value may be left behind to
   * drift from the frame's copy.
   */
  it('speaks only the names lib/widget/protocol.ts declares', async () => {
    const body = await (await GET()).text();
    const declared: Record<string, Record<string, string>> = { SOURCE, WIDGET_SAYS, HOST_SAYS };

    const used = [...body.matchAll(/\b(SOURCE|WIDGET_SAYS|HOST_SAYS)\.(\w+)/g)];
    expect(used.length).toBeGreaterThanOrEqual(13);
    for (const [, group, name] of used) {
      expect(Object.keys(declared[group!]!)).toContain(name);
    }

    expect(body).not.toMatch(/'shipblu-(host|widget)'/);
  });
});

/**
 * Just enough of a browser to run the snippet in. Every node knows its parent,
 * and every listener added to the window, the document or the visual viewport
 * is recorded until it is removed — so a test can ask whether `destroy()`
 * handed back everything the snippet took, which is the whole of its job: a
 * listener it forgets keeps answering on whatever page the reader moved to.
 */
type Listener = (...args: unknown[]) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  live(): string[] {
    return [...this.listeners].filter(([, set]) => set.size > 0).map(([type]) => type);
  }
}

class FakeNode extends FakeTarget {
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  // A real style declaration reads '' for anything unset, and the snippet saves
  // and restores the body's styles by reading them.
  readonly style: Record<string, string> = new Proxy({} as Record<string, string>, {
    get: (declared, name: string) => declared[name] ?? '',
  });
  readonly dataset: Record<string, string> = {};
  readonly contentWindow = { postMessage() {} };
  id = '';
  type = '';
  title = '';
  src = '';
  textContent = '';

  constructor(readonly tagName: string) {
    super();
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

type HostApi = Record<string, (...args: unknown[]) => void>;

function fakePage({ phone, loading = false }: { phone: boolean; loading?: boolean }) {
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  const visualViewport = Object.assign(new FakeTarget(), { width: 390, height: 844, offsetTop: 0 });
  const window = Object.assign(new FakeTarget(), {
    location: { href: 'https://help.example/ar' },
    innerHeight: 844,
    pageYOffset: 0,
    visualViewport,
    matchMedia: () => ({ matches: phone }),
    scrolls: [] as number[],
    scrollTo(_x: number, y: number) {
      window.scrolls.push(y);
    },
  }) as FakeTarget & {
    pageYOffset: number;
    scrolls: number[];
    shipbluChat?: HostApi;
    __shipbluWidget?: HostApi;
  };
  const document = Object.assign(new FakeTarget(), {
    head,
    body,
    documentElement: { scrollTop: 0 },
    readyState: loading ? 'loading' : 'complete',
    currentScript: null as FakeNode | null,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  });

  /** Adds a tag to the body and runs the snippet as that tag, as a browser would. */
  function load(source: string): FakeNode {
    const tag = new FakeNode('script');
    tag.src = 'https://help.example/widget/embed.js';
    tag.setAttribute('data-locale', 'ar');
    body.appendChild(tag);
    document.currentScript = tag;
    runInNewContext(source, { window, document, URL });
    document.currentScript = null;
    return tag;
  }

  /** The parser reaching the end of the document. */
  function parsed() {
    document.readyState = 'interactive';
    for (const listener of document.listeners.get('DOMContentLoaded') ?? []) listener();
  }

  const ids = (node: FakeNode) => node.childNodes.map((child) => child.id || child.tagName);

  return { window, document, visualViewport, head, body, load, parsed, ids };
}

describe('destroy()', () => {
  it('takes back every node and listener the snippet added, and lets go of the body', async () => {
    const source = await (await GET()).text();
    const page = fakePage({ phone: true });

    page.load(source);
    const api = page.window.shipbluChat!;
    // Open on a phone: the panel goes full screen and pins the host page.
    api.open!();

    expect(page.ids(page.body)).toEqual(['script', 'shipblu-chat-launcher', 'shipblu-chat-frame']);
    expect(page.body.style.position).toBe('fixed');
    expect(page.window.live().length).toBeGreaterThan(0);

    api.destroy!();

    expect(page.ids(page.body)).toEqual([]);
    expect(page.ids(page.head)).toEqual([]);
    expect(page.body.style.position).toBe('');
    // The page the reader is moving to has been put in place by its router.
    expect(page.window.scrolls).toEqual([]);
    expect(page.window.live()).toEqual([]);
    expect(page.document.live()).toEqual([]);
    expect(page.visualViewport.live()).toEqual([]);
    expect(page.window.shipbluChat).toBeUndefined();
    expect(page.window.__shipbluWidget).toBeUndefined();
  });

  /**
   * The two halves of "stand down": a page holding the old object cannot bring
   * the chat back by calling it, and the snippet loaded again is a working copy
   * rather than a duplicate the guard turns away.
   */
  it('leaves a stale reference inert and makes room for a fresh copy', async () => {
    const source = await (await GET()).text();
    const page = fakePage({ phone: true });

    page.load(source);
    const stale = page.window.shipbluChat!;
    // Opened before it goes, so a frame existed: on a phone, a stale open()
    // that reached it again would pin the next page's body.
    stale.open!();
    stale.destroy!();

    stale.open!();
    stale.compose!('Tracking number: 1755021358719');
    stale.toggle!();
    expect(page.ids(page.body)).toEqual([]);
    expect(page.body.style.position).toBe('');

    page.load(source);
    const fresh = page.window.shipbluChat!;
    expect(fresh).not.toBe(stale);
    expect(page.ids(page.body)).toEqual(['script', 'shipblu-chat-launcher']);

    fresh.open!();
    expect(page.ids(page.body)).toEqual(['script', 'shipblu-chat-launcher', 'shipblu-chat-frame']);
  });

  it('does not draw the launcher when the page finishes parsing after it went', async () => {
    const source = await (await GET()).text();
    const page = fakePage({ phone: false, loading: true });

    page.load(source);
    page.window.shipbluChat!.destroy!();
    page.parsed();

    expect(page.ids(page.body)).toEqual([]);
    expect(page.document.live()).toEqual([]);
  });

  it('gives up a name the host page declared with a top-level var', async () => {
    const source = await (await GET()).text();
    const page = fakePage({ phone: false });
    // What `var shipbluChat` at the top of a classic script makes it.
    Object.defineProperty(page.window, 'shipbluChat', { writable: true, configurable: false });

    page.load(source);
    expect(() => page.window.shipbluChat!.destroy!()).not.toThrow();

    expect(page.window.shipbluChat).toBeUndefined();
    expect(page.window.__shipbluWidget).toBeUndefined();
  });

  /** The scroll is withheld from `destroy()` only; a visitor closing the panel gets their place back. */
  it('still returns the page to where it was when the panel is closed', async () => {
    const source = await (await GET()).text();
    const page = fakePage({ phone: true });
    page.window.pageYOffset = 500;

    page.load(source);
    page.window.shipbluChat!.open!();
    page.window.shipbluChat!.close!();

    expect(page.window.scrolls).toEqual([500]);
  });
});
