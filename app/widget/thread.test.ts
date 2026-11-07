// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFor } from './copy';
import { type SendOutcome, WidgetThread } from './thread';

/**
 * The composer's caret when code puts words in the box, in a DOM. Each case
 * is a way it has gone wrong without anything on screen saying so: a host
 * page's second draft that left a flag behind, so the visitor's next keystroke
 * threw their caret to the end of what they were writing, and a send of files
 * alone that put an empty line in front of the words typed while it ran.
 *
 * What a visitor sees past the cap — the box scrolled to the caret — is layout,
 * which happy-dom does not do, and was measured in Chromium instead. This holds
 * what is state: which words are in the box and where the caret is.
 *
 * `.ts` with `createElement`, for the reason `components/use-action-form.test.ts`
 * gives.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  // The box asks the help centre for articles once a draft is six characters long.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => null })),
  );
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

type Props = Parameters<typeof WidgetThread>[0];

function mount(overrides: Partial<Props> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const created = createRoot(host);
  root = created;
  let props: Props = {
    locale: 'en',
    copy: copyFor('en'),
    messages: [],
    online: true,
    active: true,
    detailsSaved: true,
    prefill: null,
    onSend: vi.fn(async (): Promise<SendOutcome> => ({ ok: true })),
    onSaveDetails: vi.fn(async () => true),
    onOpenArticle: vi.fn(),
    onAnswerSurvey: vi.fn(),
    ...overrides,
  };
  act(() => created.render(createElement(WidgetThread, props)));

  const box = () => host!.querySelector('form textarea') as HTMLTextAreaElement;
  return {
    box,
    /** Re-renders with new props, as the widget does when the host page composes again. */
    update(next: Partial<Props>) {
      props = { ...props, ...next };
      act(() => created.render(createElement(WidgetThread, props)));
    },
    /** Puts the caret where a click would. */
    caretAt(at: number) {
      act(() => {
        box().focus();
        box().setSelectionRange(at, at);
      });
    },
    /**
     * Types as a keystroke does: at the field's own caret, which is the point —
     * a caret moved by the component shows up as a letter in the wrong place.
     */
    type(text: string) {
      for (const letter of text) {
        const field = box();
        const at = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? at;
        const value = field.value.slice(0, at) + letter + field.value.slice(end);
        act(() => {
          // The native setter, so React sees a change rather than its own value.
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
            field,
            value,
          );
          field.setSelectionRange(at + letter.length, at + letter.length);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
    },
  };
}

describe('the composer when the host page hands over a draft', () => {
  it('fills an empty box and puts the caret at the end of it', () => {
    const view = mount({ prefill: { text: 'First draft line\n', seq: 1 } });

    expect(view.box().value).toBe('First draft line\n');
    expect(view.box().selectionEnd).toBe('First draft line\n'.length);
    expect(document.activeElement).toBe(view.box());
  });

  it('keeps the visitor’s words over a second draft, and their next keystrokes where they put them', () => {
    const view = mount({ prefill: { text: 'First draft line\n', seq: 1 } });
    view.type('hello there');

    // Pressed again on the host page: the box keeps what the visitor wrote,
    // and only the caret moves, to the end of it.
    view.update({ prefill: { text: 'Second draft\n', seq: 2 } });
    expect(view.box().value).toBe('First draft line\nhello there');
    expect(view.box().selectionEnd).toBe(view.box().value.length);

    // A word typed into the middle stays in one piece. With the flag that
    // waited for a render, the Y went to the end of the draft.
    view.caretAt('First dr'.length);
    view.type('ZY');
    expect(view.box().value).toBe('First drZYaft line\nhello there');
    expect(view.box().selectionEnd).toBe('First drZY'.length);
  });

  it('fills the box again with the same words once it has been cleared', () => {
    const view = mount({ prefill: { text: 'Second draft\n', seq: 1 } });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        view.box(),
        '',
      );
      view.box().dispatchEvent(new Event('input', { bubbles: true }));
    });

    view.update({ prefill: { text: 'Second draft\n', seq: 2 } });
    expect(view.box().value).toBe('Second draft\n');
    expect(view.box().selectionEnd).toBe('Second draft\n'.length);
  });
});

describe('the composer when a send fails', () => {
  /** A send that waits for the test to say how it went. */
  function pendingSend() {
    let settle: (outcome: SendOutcome) => void = () => {};
    const onSend = vi.fn(
      () =>
        new Promise<SendOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    return { onSend, fail: () => settle({ ok: false, refusal: { reason: 'failed' } }) };
  }

  function pressEnter(field: HTMLTextAreaElement) {
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  }

  it('puts the words back, followed by what was typed while it ran', async () => {
    const send = pendingSend();
    const view = mount({ onSend: send.onSend });
    view.caretAt(0);
    view.type('first');
    pressEnter(view.box());
    expect(view.box().value).toBe('');

    view.type('second');
    await act(async () => send.fail());
    expect(view.box().value).toBe('first\nsecond');
  });

  it('leaves what was typed while files alone were sending as it was, with no empty first line', async () => {
    const send = pendingSend();
    const view = mount({ onSend: send.onSend });
    const picker = host!.querySelector('input[type=file]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'awb.pdf', { type: 'application/pdf' });
    act(() => {
      Object.defineProperty(picker, 'files', { value: [file], configurable: true });
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    pressEnter(view.box());
    expect(send.onSend).toHaveBeenCalledWith('', [file], null);

    view.caretAt(0);
    view.type('hello');
    await act(async () => send.fail());
    expect(view.box().value).toBe('hello');
    expect(view.box().selectionEnd).toBe('hello'.length);
  });
});
