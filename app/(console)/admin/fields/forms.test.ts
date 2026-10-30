// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * What the field editor posts for `isActive`. `saveField` has always read it as
 * `!== 'off'`, but no control on the form posted it, so the answer was always
 * "active": a field could not be deactivated, and saving one that was inactive
 * switched it back on. The `Toggle` posts a hidden `off` after its checkbox,
 * so a ticked box sends `on` first and an unticked one sends only `off`.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  unstable_rethrow: () => {},
}));
vi.mock('./actions', () => ({ saveField: vi.fn(), deleteField: vi.fn() }));

const { FieldEditor } = await import('./forms');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const FIELD = {
  id: '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c',
  key: 'order_number',
  label: 'Order number',
  labelAr: null,
  labelEn: null,
  type: 'text',
  options: [],
  validation: null,
  requiredOnCreate: false,
  requiredOnResolve: false,
  visibleToCustomer: false,
  editableByCustomer: false,
  position: 0,
  isActive: true,
};

/** Opens the editor for `field` and answers its form and its Active box. */
function openEditor(field: typeof FIELD) {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(FieldEditor, { field })));
  act(() => container.querySelector('button')!.click());

  const form = container.querySelector('form')!;
  const box = form.querySelector<HTMLInputElement>('input[type="checkbox"][name="isActive"]');
  return { form, box };
}

describe('the field editor', () => {
  it('offers an Active box, ticked for an active field, and posts it as on', () => {
    const { form, box } = openEditor(FIELD);

    expect(box?.checked).toBe(true);
    expect(new FormData(form).get('isActive')).toBe('on');
  });

  it('posts off once the box is unticked, which is what deactivates the field', () => {
    const { form, box } = openEditor(FIELD);

    act(() => box!.click());

    expect(new FormData(form).get('isActive')).toBe('off');
  });

  it('keeps an inactive field inactive when it is saved untouched', () => {
    const { form, box } = openEditor({ ...FIELD, isActive: false });

    expect(box?.checked).toBe(false);
    expect(new FormData(form).get('isActive')).toBe('off');
  });
});
