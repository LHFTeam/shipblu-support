// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionState } from '@/lib/http/action-state';
import { useActionForm } from './use-action-form';

/**
 * The hook's contract with the forms that use it, in a DOM. Each case is a way
 * it has gone wrong, or would: `onSuccess` re-run by the render its own
 * callback causes (§6.87), a refresh after a success that the action's answer
 * already made redundant (§6.87), and a refusal that wipes the draft (§6.80).
 *
 * `.ts` rather than `.tsx`, with `createElement`, because vitest collects
 * `*.test.ts` only; the DOM is happy-dom for this file alone, through the
 * pragma above, so every other test keeps the node environment.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router, unstable_rethrow: () => {} }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let now = 1_000;
let root: Root | null = null;
beforeEach(() => {
  router.refresh.mockClear();
  // A success the action answered without a nonce is given Date.now(): make
  // each one distinct, as two network round trips always are.
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
});

type Answer = ActionState | Error;
const success = (nonce?: number): ActionState => ({
  error: null,
  ok: true,
  ...(nonce ? { nonce } : {}),
});
const refusal = (): ActionState => ({ error: 'Refused' });

/** A composer around a reply form, shaped like `composer.tsx` and `reply-form.tsx`. */
function mount() {
  const answers: Answer[] = [];
  const onSuccess = vi.fn();
  const handles = {} as { reopen: () => void; collapsed: () => boolean; rerender: () => void };

  async function action(_previous: ActionState, _formData: FormData): Promise<ActionState> {
    const next = answers.shift() ?? refusal();
    if (next instanceof Error) throw next;
    return next;
  }

  function ReplyForm({ onSent }: { onSent: () => void }) {
    const { state, key, form } = useActionForm(action, { error: null }, { onSuccess: onSent });
    return createElement(
      'form',
      { key, ...form },
      createElement('textarea', { name: 'body', defaultValue: '' }),
      createElement('button', { type: 'submit' }, 'Send'),
      state.error ? createElement('p', { role: 'alert' }, state.error) : null,
    );
  }

  // The callback is a new closure every render and sets the parent's state —
  // the shape that, as an effect dependency, re-ran the effect after the render
  // it caused.
  function Composer() {
    const [collapsed, setCollapsed] = useState(false);
    const [, setTick] = useState(0);
    handles.reopen = () => setCollapsed(false);
    handles.collapsed = () => collapsed;
    handles.rerender = () => setTick((n) => n + 1);
    return createElement(ReplyForm, {
      onSent: () => {
        onSuccess();
        setCollapsed(true);
      },
    });
  }

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Composer)));

  const textarea = () => container.querySelector('textarea')!;
  async function send(answer: Answer, draft = 'Hello') {
    answers.push(answer);
    textarea().value = draft;
    await act(async () => {
      container.querySelector('button')!.click();
    });
  }
  return { send, onSuccess, handles, textarea, container };
}

describe('useActionForm onSuccess', () => {
  it('runs once per success, including two in a row and one with no nonce', async () => {
    const { send, onSuccess } = mount();
    await send(success(1));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await send(success(2));
    expect(onSuccess).toHaveBeenCalledTimes(2);
    await send(success()); // a bare `{ ok: true }`: the hook supplies the nonce
    await send(success());
    expect(onSuccess).toHaveBeenCalledTimes(4);
  });

  it('never runs for a refusal or a thrown action', async () => {
    const { send, onSuccess } = mount();
    await send(refusal());
    await send(new Error('connection dropped'));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalledTimes(1); // the lost path still re-reads
    await send(success(1));
    await send(refusal());
    await send(new Error('again'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not refresh the router after a success', async () => {
    const { send } = mount();
    await send(success(1));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('is not run again by the parent state its callback sets, or by a re-render', async () => {
    const { send, onSuccess, handles } = mount();
    await send(success(1));
    expect(handles.collapsed()).toBe(true);
    act(() => handles.reopen());
    act(() => handles.rerender());
    expect(handles.collapsed()).toBe(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft on a refusal and clears it on a success (§6.80)', async () => {
    const { send, textarea, container } = mount();
    await send(refusal(), 'Half a reply');
    expect(container.querySelector('[role=alert]')?.textContent).toBe('Refused');
    expect(textarea().value).toBe('Half a reply');
    await send(success(1), 'The whole reply');
    expect(textarea().value).toBe('');
    // The second half of §6.80: a refusal after a success kept no nonce, so the
    // key fell back and the remount wiped the draft on the second send instead.
    await send(refusal(), 'The next reply');
    expect(textarea().value).toBe('The next reply');
  });

  // A help-centre form's `error` is a key its page translates, and no action
  // there answers `ok: true`, so an `onSuccess` would never run: the type says so.
  it('is refused by type on a form whose error is a key', () => {
    type KeyState = { error: 'errorNoAnswer' | 'errorMissing' | null; ok?: boolean };
    const answer = async (state: KeyState) => state;
    const typed = (form: typeof useActionForm<KeyState>) => {
      // @ts-expect-error a key-errored form takes no onSuccess
      form(answer, { error: null }, { lost: 'errorNoAnswer', onSuccess: () => {} });
      form(answer, { error: null }, { lost: 'errorNoAnswer' });
    };
    expect(typed).toBeTypeOf('function');
  });
});
