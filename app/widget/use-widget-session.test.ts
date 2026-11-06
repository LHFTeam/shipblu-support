// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { personDigest, personKey } from '@/lib/widget/person';
import { readToken, readTokenPerson, writeToken, writeTokenPerson } from '@/lib/widget/token-store';
import type { WidgetView } from '@/lib/widget/types';
import { useWidgetSession } from './use-widget-session';

/**
 * The frame's half of the person check (`lib/widget/person.ts`), in a DOM: a
 * stored conversation is reopened only once the host page has said who is
 * reading, and only for the person it was vouched for. Every case that refuses
 * is asserted on the request that was never made, because that request is the
 * leak — it returns the previous person's transcript, and the thread draws it.
 *
 * `.ts` with `createElement`, and happy-dom for this file alone, for the
 * reasons `components/use-action-form.test.ts` gives.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const NOUR = { accountId: 4471, email: 'nour@merchant.example', phone: '+20 100 123 4567' };
const OMAR = { accountId: 4471, email: 'omar@merchant.example', phone: null };
const digestOf = async (person: unknown) => (await personDigest(personKey(person)))!;

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let root: Root | null = null;

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
  frame(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ url, body });
      if (url === '/api/widget/session') {
        const token = body.token ? String(body.token) : 'T-new';
        const messages = body.token ? [{ id: 'm1', from: 'agent', body: 'Hello Nour' }] : [];
        return Response.json({
          token,
          conversationId: 'c1',
          messages,
          online: true,
          opensAt: null,
        });
      }
      return Response.json({ ok: true, verified: false });
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

/** Lets the digest, the fetch and the renders after them all finish. */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const resumes = () => calls.filter((call) => call.url === '/api/widget/session');

/** A token left behind by the previous person, vouched for or not. */
async function leftBehind(vouchedFor: unknown) {
  writeToken('T-prev');
  if (vouchedFor) writeTokenPerson('T-prev', await digestOf(vouchedFor));
}

describe('reopening a stored conversation', () => {
  it('waits for the host page to say who is reading before asking for it', async () => {
    await leftBehind(NOUR);
    const page = mount();
    await settle();
    expect(resumes()).toEqual([]);

    page.session.hearHost(NOUR, true);
    await settle();
    expect(resumes()).toEqual([{ url: '/api/widget/session', body: { token: 'T-prev' } }]);
    expect(page.session.messages).toHaveLength(1);
    expect(page.view()).toBe('thread');
  });

  it('refuses it to somebody else, without asking the server anything', async () => {
    await leftBehind(NOUR);
    const page = mount();

    page.session.hearHost(OMAR, true);
    await settle();

    expect(resumes()).toEqual([]);
    expect(page.session.messages).toEqual([]);
    expect(page.view()).toBe('home');
    expect(readToken()).toBeNull();
    expect(readTokenPerson('T-prev')).toBeNull();
  });

  it('refuses a token never vouched for to a page that names somebody', async () => {
    // Every token left before the check: each one survived a sign-out.
    await leftBehind(null);
    const page = mount();

    page.session.hearHost(NOUR, true);
    await settle();

    expect(resumes()).toEqual([]);
    expect(readToken()).toBeNull();
  });

  it("refuses a merchant's conversation to a page that names nobody", async () => {
    await leftBehind(NOUR);
    const page = mount();

    page.session.hearHost(null, true);
    await settle();

    expect(resumes()).toEqual([]);
    expect(readToken()).toBeNull();
  });

  it('reopens an anonymous conversation on a page that names nobody', async () => {
    await leftBehind(null);
    const page = mount();

    page.session.hearHost(null, true);
    await settle();

    expect(resumes()).toHaveLength(1);
  });

  it('reopens as before for a snippet that does not say', async () => {
    await leftBehind(NOUR);
    const page = mount();

    page.session.hearHost(undefined, false);
    await settle();

    expect(resumes()).toHaveLength(1);
  });

  it('reads a frame nobody framed as naming nobody, at once', async () => {
    frame(false);
    await leftBehind(NOUR);
    mount();
    await settle();

    expect(resumes()).toEqual([]);
    expect(readToken()).toBeNull();
  });

  it('holds a visitor who presses the button first to the same check', async () => {
    await leftBehind(NOUR);
    const page = mount();

    let minted: Promise<string | null> = Promise.resolve(null);
    act(() => {
      minted = page.session.ensureSession();
    });
    await settle();
    expect(resumes()).toEqual([]);

    page.session.hearHost(OMAR, true);
    await settle();
    await act(async () => {
      await minted;
    });

    // A fresh session for Omar, and Nour's token was never sent.
    expect(resumes().map((call) => call.body.token)).toEqual(['']);
    expect(readToken()).toBe('T-new');
    expect(readTokenPerson('T-new')).toBe(await digestOf(OMAR));
  });
});

describe('the identity the host page sends after the session exists', () => {
  it('throws away a session vouched for as somebody else before telling the server', async () => {
    await leftBehind(NOUR);
    const page = mount();
    // A snippet older than the field: the stored conversation reopens as before.
    page.session.hearHost(undefined, false);
    await settle();
    expect(page.session.token).toBe('T-prev');

    page.identityRef.current = { identity: OMAR, signature: null };
    await act(async () => {
      await page.session.sendIdentity('T-prev');
    });
    await settle();

    expect(calls.filter((call) => call.url === '/api/widget/identify')).toEqual([]);
    expect(page.session.token).toBeNull();
    expect(page.session.messages).toEqual([]);
    expect(readToken()).toBeNull();
  });

  it('vouches for a session as the person identified, ahead of the request', async () => {
    await leftBehind(null);
    const page = mount();
    page.session.hearHost(undefined, false);
    await settle();

    page.identityRef.current = { identity: NOUR, signature: null };
    await act(async () => {
      await page.session.sendIdentity('T-prev');
    });

    expect(readTokenPerson('T-prev')).toBe(await digestOf(NOUR));
    expect(calls.filter((call) => call.url === '/api/widget/identify')).toHaveLength(1);
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
