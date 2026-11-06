// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statementOf, type PersonPrint } from '@/lib/widget/person';
import { readToken, readTokenPerson, writeToken, writeTokenPerson } from '@/lib/widget/token-store';
import type { WidgetView } from '@/lib/widget/types';
import { useWidgetSession } from './use-widget-session';

/**
 * The frame's half of the person check (`lib/widget/person.ts`), in a DOM: a
 * stored conversation is reopened only once the host page has said who is
 * reading, and only for the person it was vouched for. Every case that refuses
 * is asserted on the request that was never made, or on the transcript never
 * drawn, because that is the leak — the session request returns the previous
 * person's conversation, and the thread draws it.
 *
 * `.ts` with `createElement`, and happy-dom for this file alone, for the
 * reasons `components/use-action-form.test.ts` gives.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const NOUR = { accountId: 4471, email: 'nour@merchant.example', phone: '+20 100 123 4567' };
const OMAR = { accountId: 4471, email: 'omar@merchant.example', phone: null };
const printOf = async (person: unknown) => (await statementOf(person, true)) as PersonPrint;

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let root: Root | null = null;
/** Session requests wait on this while it is set, so a test can speak while one is in flight. */
let hold: Promise<void> | null = null;
/** Stored tokens the server no longer recognises, and the token it answers each with. */
let replaced: Record<string, string> = {};

/** Framed, as the widget always is on a host page; unframed is its own case below. */
function frame(framed: boolean) {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: framed ? { postMessage() {} } : window,
  });
}

beforeEach(() => {
  localStorage.clear();
  calls = [];
  hold = null;
  replaced = {};
  frame(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, body });
      if (url !== '/api/widget/session') return Response.json({ ok: true, verified: false });

      if (hold) await hold;
      const sent = body.token ? String(body.token) : '';
      const known = sent && !replaced[sent];
      const token = known ? sent : (replaced[sent] ?? 'T-new');
      const messages = known ? [{ id: 'm1', from: 'agent', body: 'Hello Nour' }] : [];
      return Response.json({ token, conversationId: 'c1', messages, online: true, opensAt: null });
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

type Session = ReturnType<typeof useWidgetSession>;

function mount() {
  const handle = {} as {
    session: Session;
    identityRef: { current: { identity: unknown; signature: string | null } | null };
    view: () => WidgetView;
  };

  function Harness() {
    const [view, setView] = useState<WidgetView>('home');
    const [, setThreadStarted] = useState(false);
    const seenCount = useRef(0);
    const activeToken = useRef<string | null>(null);
    const identity = useRef<{ identity: unknown; signature: string | null } | null>(null);
    const resets = useRef(0);
    const navigated = useRef(false);
    handle.session = useWidgetSession({
      initialOnline: true,
      initialOpensAt: null,
      seenCountRef: seenCount,
      activeTokenRef: activeToken,
      identityRef: identity,
      resetsRef: resets,
      navigatedRef: navigated,
      setView,
      setThreadStarted,
    });
    handle.identityRef = identity;
    handle.view = () => view;
    return null;
  }

  act(() => {
    root = createRoot(document.createElement('div'));
    root.render(createElement(Harness));
  });
  return handle;
}

/** Lets the digests, the fetches and the renders after them all finish. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Holds session requests until the returned function is called. */
function holdRequests() {
  let release: () => void = () => {};
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    hold = null;
    release();
    await settle();
  };
}

const resumes = () => calls.filter((call) => call.url === '/api/widget/session');
const identifies = () => calls.filter((call) => call.url === '/api/widget/identify');

/** A token left behind by the previous person, vouched for or not. */
async function leftBehind(vouchedFor: unknown, token = 'T-prev') {
  writeToken(token);
  if (vouchedFor) writeTokenPerson(token, await printOf(vouchedFor));
}

async function say(page: ReturnType<typeof mount>, person: unknown, carried = true) {
  page.session.hearHost(person, carried);
  await settle();
}

describe('reopening a stored conversation', () => {
  it('waits for the host page to say who is reading before asking for it', async () => {
    await leftBehind(NOUR);
    const page = mount();
    await settle();
    expect(resumes()).toEqual([]);

    await say(page, NOUR);
    expect(resumes()).toEqual([{ url: '/api/widget/session', body: { token: 'T-prev' } }]);
    expect(page.session.messages).toHaveLength(1);
    expect(page.view()).toBe('thread');
  });

  it('throws it away for somebody else, without asking the server anything', async () => {
    await leftBehind(NOUR);
    const page = mount();
    await say(page, OMAR);

    expect(resumes()).toEqual([]);
    expect(page.session.messages).toEqual([]);
    expect(page.view()).toBe('home');
    expect(readToken()).toBeNull();
    expect(readTokenPerson('T-prev')).toBeNull();
  });

  it('throws away a token never vouched for, for a page that names somebody', async () => {
    // Every token left before the check: each one survived a sign-out.
    await leftBehind(null);
    const page = mount();
    await say(page, NOUR);

    expect(resumes()).toEqual([]);
    expect(readToken()).toBeNull();
  });

  it("does not reopen a merchant's conversation on a page that names nobody, and keeps it for them", async () => {
    await leftBehind(NOUR);
    const page = mount();
    await say(page, null);

    expect(resumes()).toEqual([]);
    expect(readToken()).toBe('T-prev');

    // Back where the page says who is reading, the conversation is there.
    await say(page, NOUR);
    expect(resumes()).toEqual([{ url: '/api/widget/session', body: { token: 'T-prev' } }]);
    expect(page.session.messages).toHaveLength(1);
  });

  it('reopens an anonymous conversation on a page that names nobody', async () => {
    await leftBehind(null);
    const page = mount();
    await say(page, null);

    expect(resumes()).toHaveLength(1);
  });

  it('reopens as before for a snippet that does not say', async () => {
    await leftBehind(NOUR);
    const page = mount();
    await say(page, undefined, false);

    expect(resumes()).toHaveLength(1);
  });

  it('keeps a frame nobody framed off the conversation, without deleting it', async () => {
    frame(false);
    await leftBehind(NOUR);
    mount();
    await settle();

    expect(resumes()).toEqual([]);
    expect(readToken()).toBe('T-prev');
  });

  it('waits for the rest of a page that says less than the record, and reopens once it does', async () => {
    // A dashboard that hands over the email first and the account after its
    // profile request returns.
    await leftBehind(NOUR);
    const page = mount();
    await say(page, { email: NOUR.email });
    expect(resumes()).toEqual([]);
    expect(readToken()).toBe('T-prev');

    await say(page, NOUR);
    expect(resumes()).toHaveLength(1);
    expect(page.session.messages).toHaveLength(1);
  });

  it('draws nothing when the page names somebody else while the request is in flight', async () => {
    await leftBehind(NOUR);
    const page = mount();
    const release = holdRequests();
    await say(page, NOUR);
    expect(resumes()).toHaveLength(1);

    await say(page, OMAR);
    await release();

    expect(page.session.messages).toEqual([]);
    expect(page.session.token).toBeNull();
    expect(page.view()).toBe('home');
    expect(readToken()).toBeNull();
  });

  it('records a token the server replaced for the person it was reopened for', async () => {
    await leftBehind(NOUR, 'T-unknown');
    replaced['T-unknown'] = 'T-replaced';
    const page = mount();
    await say(page, NOUR);

    expect(readToken()).toBe('T-replaced');
    expect(readTokenPerson('T-replaced')).toEqual(await printOf(NOUR));
  });
});

describe('a visitor who presses the button', () => {
  it('is held to the same check, and their fresh session is vouched for as them', async () => {
    await leftBehind(NOUR);
    const page = mount();

    let minted: Promise<string | null> = Promise.resolve(null);
    act(() => {
      minted = page.session.ensureSession();
    });
    await settle();
    expect(resumes()).toEqual([]);

    await say(page, OMAR);
    await act(async () => {
      await minted;
    });

    // A fresh session for Omar, and Nour's token was never sent.
    expect(resumes().map((call) => call.body.token)).toEqual(['']);
    expect(readToken()).toBe('T-new');
    expect(readTokenPerson('T-new')).toEqual(await printOf(OMAR));
  });

  it("never relabels the previous person's token as theirs when the page changes mid-request", async () => {
    await leftBehind(NOUR);
    const page = mount();
    await say(page, NOUR);
    // The resume on the mount has reopened it; start over with a session request held.
    await act(async () => {
      page.session.startFreshSession();
    });
    await leftBehind(NOUR);
    calls = [];

    const release = holdRequests();
    let minted: Promise<string | null> = Promise.resolve(null);
    act(() => {
      minted = page.session.ensureSession();
    });
    await settle();
    expect(resumes().map((call) => call.body.token)).toEqual(['T-prev']);

    await say(page, OMAR);
    await release();
    await act(async () => {
      await minted;
    });

    // Refused once it was back, and a session of Omar's own instead.
    expect(page.session.token).toBe('T-new');
    expect(page.session.messages).toEqual([]);
    expect(readTokenPerson('T-new')).toEqual(await printOf(OMAR));
    expect(readTokenPerson('T-prev')).toBeNull();
  });
});

describe('the identity the host page sends once the session exists', () => {
  it('throws away a session vouched for as somebody else before telling the server', async () => {
    await leftBehind(NOUR);
    const page = mount();
    // A snippet older than the field: the stored conversation reopens as before.
    await say(page, undefined, false);
    expect(page.session.token).toBe('T-prev');

    page.identityRef.current = { identity: OMAR, signature: null };
    await act(async () => {
      await page.session.sendIdentity('T-prev');
    });
    await settle();

    expect(identifies()).toEqual([]);
    expect(page.session.token).toBeNull();
    expect(page.session.messages).toEqual([]);
    expect(readToken()).toBeNull();
  });

  it('adds what the page hands over later to the record, and keeps the conversation going', async () => {
    const page = mount();
    await say(page, { email: NOUR.email });
    await act(async () => {
      await page.session.ensureSession();
    });
    expect(readTokenPerson('T-new')).toEqual(await printOf({ email: NOUR.email }));

    page.identityRef.current = { identity: NOUR, signature: null };
    await act(async () => {
      await page.session.sendIdentity('T-new');
    });

    expect(page.session.token).toBe('T-new');
    expect(readTokenPerson('T-new')).toEqual(await printOf(NOUR));
    expect(identifies()).toHaveLength(1);
  });

  it('refuses to vouch with nothing to check against, without wiping a session minted here', async () => {
    await leftBehind(NOUR);
    const page = mount();
    await say(page, undefined, false);
    expect(page.session.token).toBe('T-prev');

    // A frame under an insecure ancestor has no Web Crypto to take a digest with.
    vi.stubGlobal('crypto', {});
    page.identityRef.current = { identity: OMAR, signature: null };
    await act(async () => {
      await page.session.sendIdentity('T-prev');
    });
    expect(identifies()).toEqual([]);
    expect(page.session.token).toBeNull();

    // A session minted in this document is the reader's, and goes on.
    await act(async () => {
      await page.session.ensureSession();
    });
    await act(async () => {
      await page.session.sendIdentity('T-new');
    });
    expect(page.session.token).toBe('T-new');
    expect(identifies()).toHaveLength(1);
  });

  it('sends nothing for a token that is no longer the session', async () => {
    const page = mount();
    page.identityRef.current = { identity: NOUR, signature: null };
    await act(async () => {
      await page.session.sendIdentity('T-gone');
    });

    expect(calls).toEqual([]);
  });
});
