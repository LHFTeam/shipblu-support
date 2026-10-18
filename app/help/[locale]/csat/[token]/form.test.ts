// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORDING, ratingLabels } from '@/lib/csat/wording';
import { t } from '@/lib/kb/locale';
import { SurveyForm } from './form';

/**
 * The survey page's scale, in a DOM. The first answer is the one kept, so
 * every case here is a way the screen could come to show a rating the server
 * does not hold: a second tap drawn over the first, a tap whose reply was lost
 * reopening the scale to a different one, and a failure that looks like an
 * answer.
 *
 * `.ts` with `createElement`, for the reason `components/use-action-form.test.ts`
 * gives.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

const labels = ratingLabels('en');
const NOT_CONFIRMED = t('en', 'csatNotConfirmed');

/** The route's answers, in order: a status, or `'drop'` for a reply that never came. */
function route(answers: (number | 'drop' | 'hang')[]) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const answer = answers.shift() ?? 204;
    if (answer === 'drop') throw new TypeError('Failed to fetch');
    // Never answered, until the page's own deadline gives up on it.
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
      );
    }
    return new Response(null, { status: answer });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** The route, answering each post only when the test says, in any order. */
function heldRoute() {
  const held: ((status: number) => void)[] = [];
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        held.push((status) => resolve(new Response(null, { status })));
      }),
  );
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    answer: async (call: number, status: number) => {
      await act(async () => {
        held[call]!(status);
      });
    },
  };
}

function mount(props: { preselected?: number | null; preview?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(SurveyForm, {
        token: 'token-1',
        locale: 'en',
        wording: DEFAULT_WORDING.en,
        ...props,
      }),
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...host!.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

/** Shut the way the page shuts a rating: announced, and still able to hold focus. */
const shut = (target: HTMLButtonElement) =>
  target.getAttribute('aria-disabled') === 'true' && !target.disabled;

async function type(value: string) {
  const box = host!.querySelector('textarea')!;
  await act(async () => {
    // React tracks a controlled value through the setter on the prototype.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(target: HTMLElement) {
  await act(async () => {
    target.click();
  });
}

function posted(fetch: ReturnType<typeof route>, call: number) {
  const init = (fetch.mock.calls[call] as unknown as [string, RequestInit])[1];
  return JSON.parse(String(init.body)) as { token: string; rating: number; comment: string | null };
}

const text = () => host!.textContent ?? '';

describe('SurveyForm', () => {
  it('shuts the scale on the rating tapped, and a second tap posts nothing', async () => {
    const fetch = route([204]);
    mount();

    await click(button(labels[0]));
    await click(button(labels[3]));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(posted(fetch, 0)).toEqual({ token: 'token-1', rating: 1, comment: null });
    expect(button(labels[0]).getAttribute('aria-pressed')).toBe('true');
    expect(button(labels[3]).getAttribute('aria-pressed')).toBe('false');
    for (const label of labels) expect(shut(button(label))).toBe(true);
    expect(text()).not.toContain(NOT_CONFIRMED);
  });

  it('keeps the scale shut on a tap whose reply was lost, says so, and sends the same rating again', async () => {
    // The reply that never came may have followed a rating the server kept: a
    // scale reopened here would take a 4 the route ignores while the 1 stands.
    const fetch = route(['drop', 204]);
    mount();

    await click(button(labels[0]));

    expect(text()).toContain(NOT_CONFIRMED);
    for (const label of labels) expect(shut(button(label))).toBe(true);
    expect(button(labels[0]).getAttribute('aria-pressed')).toBe('true');

    await click(button(DEFAULT_WORDING.en.button));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(posted(fetch, 1)).toEqual({ token: 'token-1', rating: 1, comment: null });
    expect(text()).toContain(DEFAULT_WORDING.en.thanks);
  });

  // happy-dom keeps focus on a button that becomes disabled, where Chromium
  // moves it to the body: `shut` is what holds the attribute here, and this
  // the focus, in an engine that would show a regression only in a browser.
  it('keeps focus on the rating pressed, so a keyboard user is not sent back to the top', async () => {
    route([204]);
    mount();

    const pressed = button(labels[0]);
    pressed.focus();
    await click(pressed);

    expect(document.activeElement).toBe(pressed);
  });

  it('thanks the customer only once the route has taken the rating', async () => {
    // A carrier's shared address over the route's hourly limit, and still over
    // it a minute later: a thanks after the second refusal would be for nothing.
    const fetch = route(['drop', 429, 204]);
    mount();

    await click(button(labels[0]));
    await type('It never came.');
    await click(button(DEFAULT_WORDING.en.button));

    expect(text()).not.toContain(DEFAULT_WORDING.en.thanks);
    expect(text()).toContain(NOT_CONFIRMED);
    expect(host!.querySelector('textarea')!.value).toBe('It never came.');

    await click(button(DEFAULT_WORDING.en.button));

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(posted(fetch, 2)).toEqual({ token: 'token-1', rating: 1, comment: 'It never came.' });
    expect(text()).toContain(DEFAULT_WORDING.en.thanks);
  });

  it('posts a rating the link named from the button, shutting the scale on it, and waits for the route', async () => {
    const fetch = route(['drop']);
    mount({ preselected: 2 });

    await click(button(DEFAULT_WORDING.en.button));

    expect(posted(fetch, 0)).toEqual({ token: 'token-1', rating: 2, comment: null });
    expect(text()).not.toContain(DEFAULT_WORDING.en.thanks);
    expect(text()).toContain(NOT_CONFIRMED);
    expect(shut(button(labels[4]))).toBe(true);
    expect(button(labels[1]).getAttribute('aria-pressed')).toBe('true');
  });

  it('waits for the route when the button is pressed while the tap is still on the wire', async () => {
    // The tap never settles; the button's own post of the same rating drops.
    // Thanked on the tap's say-so, the customer would believe they answered.
    const fetch = route(['hang', 'drop']);
    mount();

    await click(button(labels[0]));
    await type('It never came.');
    await click(button(DEFAULT_WORDING.en.button));

    expect(posted(fetch, 1)).toEqual({ token: 'token-1', rating: 1, comment: 'It never came.' });
    expect(text()).not.toContain(DEFAULT_WORDING.en.thanks);
    expect(text()).toContain(NOT_CONFIRMED);
  });

  it('says it is sending while the button’s post is on the wire, and takes no second press', async () => {
    const fetch = route(['drop', 'hang']);
    mount();

    await click(button(labels[0]));
    await click(button(DEFAULT_WORDING.en.button));

    const busy = button(t('en', 'csatSending'));
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await click(busy);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('takes no second press of the button while its first post of a preselected rating is on the wire', async () => {
    const fetch = route(['hang']);
    mount({ preselected: 2 });

    await click(button(DEFAULT_WORDING.en.button));
    await click(button(t('en', 'csatSending')));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain(DEFAULT_WORDING.en.thanks);
  });

  it('thanks the customer when the tap was taken while the button’s own post was out, whatever that post meets', async () => {
    // The tap is slow; Send is pressed meanwhile; the tap is taken, and only
    // then is the button's post refused. The rating is in: saying it may not
    // be, and offering to send it again, would be the page contradicting the
    // route.
    const { answer } = heldRoute();
    mount();

    await click(button(labels[0]));
    await click(button(DEFAULT_WORDING.en.button));
    await answer(0, 204);
    await answer(1, 429);

    expect(text()).not.toContain(NOT_CONFIRMED);
    expect(text()).toContain(DEFAULT_WORDING.en.thanks);
  });

  it('gives up on a post nothing answers, and gives the customer the button back', async () => {
    vi.useFakeTimers();
    try {
      route(['hang', 204]);
      mount({ preselected: 2 });

      await click(button(DEFAULT_WORDING.en.button));
      expect(button(t('en', 'csatSending')).getAttribute('aria-busy')).toBe('true');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(text()).toContain(NOT_CONFIRMED);
      await click(button(DEFAULT_WORDING.en.button));
      expect(text()).toContain(DEFAULT_WORDING.en.thanks);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a comment after a rating the route took without waiting on it', async () => {
    // The score is in; the comment's reply never comes, and the thanks does not wait.
    const fetch = route([204, 'hang']);
    mount();

    await click(button(labels[3]));
    await type('Quick');
    await click(button(DEFAULT_WORDING.en.button));

    expect(posted(fetch, 1)).toEqual({ token: 'token-1', rating: 4, comment: 'Quick' });
    expect(text()).toContain(DEFAULT_WORDING.en.thanks);
  });

  it('posts nothing from the button after a rating the route took, when there is no comment', async () => {
    // The route would ignore it, and it would spend the shared address's limit.
    const fetch = route([204]);
    mount();

    await click(button(labels[3]));
    await click(button(DEFAULT_WORDING.en.button));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text()).toContain(DEFAULT_WORDING.en.thanks);
  });

  it('says a refused tap was not confirmed too, rather than drawing it as answered', async () => {
    // The route's 20-an-hour limit, which a carrier's shared address reaches.
    route([429]);
    mount();

    await click(button(labels[1]));

    expect(text()).toContain(NOT_CONFIRMED);
    expect(button(labels[1]).getAttribute('aria-pressed')).toBe('true');
  });

  it('takes no second tap while the first is on the wire', async () => {
    const fetch = route(['hang']);
    mount();

    await click(button(labels[0]));
    await click(button(labels[4]));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(button(labels[0]).getAttribute('aria-pressed')).toBe('true');
    expect(text()).not.toContain(NOT_CONFIRMED);
  });

  it('moves a rating the link named until the first tap, then shuts on that tap', async () => {
    const fetch = route([204]);
    mount({ preselected: 4 });

    expect(button(labels[3]).getAttribute('aria-pressed')).toBe('true');
    expect(shut(button(labels[1]))).toBe(false);

    await click(button(labels[1]));

    expect(posted(fetch, 0).rating).toBe(2);
    expect(button(labels[1]).getAttribute('aria-pressed')).toBe('true');
    expect(shut(button(labels[3]))).toBe(true);
  });

  it('shuts in preview as the customer would see it, and posts nothing', async () => {
    const fetch = route([]);
    mount({ preview: true });

    await click(button(labels[0]));

    expect(fetch).not.toHaveBeenCalled();
    expect(shut(button(labels[2]))).toBe(true);
    expect(text()).not.toContain(NOT_CONFIRMED);
  });
});
