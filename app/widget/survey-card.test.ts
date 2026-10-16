// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORDING, ratingLabels } from '@/lib/csat/wording';
import type { WidgetSurvey } from '@/lib/widget/types';
import { SurveyCard, type SurveyResult } from './survey-card';

/**
 * The card's contract with the visitor, in a DOM. Each case is a way a survey
 * card goes wrong without anything on screen saying so: a rating that did not
 * go through drawn as answered, a second tap drawn over the answer the server
 * kept, a closed survey offering a scale, and an answer from an earlier visit
 * reopened for a comment this card never asked for.
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
});

function survey(overrides: Partial<WidgetSurvey> = {}): WidgetSurvey {
  return {
    id: 'survey-1',
    rating: null,
    expired: false,
    locale: 'en',
    ...DEFAULT_WORDING.en,
    labels: ratingLabels('en'),
    ...overrides,
  };
}

function mount(props: WidgetSurvey, answers: SurveyResult[]) {
  const onAnswer = vi.fn(async (): Promise<SurveyResult> =>
    answers.length ? answers.shift()! : false,
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(SurveyCard, { survey: props, onAnswer })));
  return onAnswer;
}

function ratingButton(label: string): HTMLButtonElement {
  const button = [...host!.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button ${label}`);
  return button;
}

async function click(button: HTMLElement) {
  await act(async () => {
    button.click();
  });
}

const text = () => host!.textContent ?? '';

describe('SurveyCard', () => {
  it('records the tapped rating, then asks for a comment and thanks the visitor', async () => {
    const onAnswer = mount(survey(), [4, 4]);

    await click(ratingButton('Good'));
    expect(onAnswer).toHaveBeenLastCalledWith('survey-1', 4, null);
    expect(ratingButton('Good').getAttribute('aria-pressed')).toBe('true');
    // Kept is kept: the scale is shut once the server has the rating.
    expect(ratingButton('Bad').disabled).toBe(true);

    const box = host!.querySelector('textarea')!;
    await act(async () => {
      // React tracks a controlled value through the setter on the prototype.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        box,
        'Quick',
      );
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(ratingButton(DEFAULT_WORDING.en.button));

    expect(onAnswer).toHaveBeenLastCalledWith('survey-1', 4, 'Quick');
    expect(text()).toContain(DEFAULT_WORDING.en.thanks);
    expect(host!.querySelector('textarea')).toBeNull();
  });

  it('puts a rating that did not go through back, and says so', async () => {
    const onAnswer = mount(survey(), [false, 2]);

    await click(ratingButton('Bad'));
    expect(ratingButton('Bad').getAttribute('aria-pressed')).toBe('false');
    expect(ratingButton('Great').disabled).toBe(false);
    expect(text()).toContain('That did not go through');
    expect(host!.querySelector('textarea')).toBeNull();

    await click(ratingButton('Bad'));
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(ratingButton('Bad').getAttribute('aria-pressed')).toBe('true');
    expect(text()).not.toContain('That did not go through');
  });

  it('draws the rating the server kept, not a second tap after a lost reply', async () => {
    // The first tap's reply was lost; the server holds its 5, and answers the
    // second tap with it.
    mount(survey(), [5]);

    await click(ratingButton('Okay'));

    expect(ratingButton('Great').getAttribute('aria-pressed')).toBe('true');
    expect(ratingButton('Okay').getAttribute('aria-pressed')).toBe('false');
  });

  it('offers no scale for a survey a newer one closed, or one the server finds nothing to answer in', async () => {
    mount(survey({ expired: true }), []);
    expect(text()).toContain('This survey has closed.');
    expect(host!.querySelectorAll('button')).toHaveLength(0);
    act(() => root!.unmount());

    const onAnswer = mount(survey(), [null]);
    await click(ratingButton('Great'));
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(text()).toContain('This survey has closed.');
  });

  it('shows an answer from an earlier visit as answered, with no comment box to reopen', () => {
    mount(survey({ rating: 3 }), []);

    expect(ratingButton('Okay').getAttribute('aria-pressed')).toBe('true');
    expect(ratingButton('Okay').disabled).toBe(true);
    expect(host!.querySelector('textarea')).toBeNull();
    expect(text()).toContain(DEFAULT_WORDING.en.thanks);
  });

  it('speaks the survey’s language and direction, whatever the widget’s', () => {
    mount(survey({ locale: 'ar', ...DEFAULT_WORDING.ar, labels: ratingLabels('ar') }), []);

    const card = host!.firstElementChild!;
    expect(card.getAttribute('dir')).toBe('rtl');
    expect(card.getAttribute('lang')).toBe('ar');
    expect(text()).toContain(DEFAULT_WORDING.ar.question);
    expect(ratingButton(ratingLabels('ar')[0])).toBeTruthy();
  });
});
