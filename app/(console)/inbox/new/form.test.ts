// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CategoryChoice } from '@/lib/categories/choices';
import { parseFormElements } from '@/lib/forms/elements';
import { createTicketFromForm } from './actions';
import { ConsoleTicketForm } from './form';

/**
 * What survives the agent switching form on the New page, in a DOM.
 *
 * Next keeps a page's client state across `?form=` links, because the router's
 * cache key ignores search params, so the form component is re-rendered with
 * the next form's props rather than mounted afresh. Two things follow, and each
 * was wrong once: what depends on the form — its answers, the priority seeded
 * from its default, the category chosen for it — must start again, or a choice
 * made for one form is posted with another; and who the ticket is for must not,
 * or an agent who typed the caller's address before seeing the request belongs
 * to another form types it again.
 */

vi.mock('./actions', () => ({ createTicketFromForm: vi.fn(async () => ({ error: null })) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  unstable_rethrow: () => {},
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const categories: CategoryChoice[] = [
  { id: '00000000-0000-4000-8000-000000000001', labelEn: 'Sales', isActive: true },
  { id: '00000000-0000-4000-8000-000000000002', labelEn: 'Merchant support', isActive: true },
];

// One placed question, the priority, so the seed from each form's default shows.
const elements = parseFormElements([{ kind: 'system', key: 'priority' }], []);

function render(container: HTMLElement, slug: string, defaultPriority: string) {
  act(() =>
    root!.render(
      createElement(ConsoleTicketForm, {
        slug,
        elements,
        fields: [],
        defaultPriority,
        categories,
        defaultCategoryLabel: null,
      }),
    ),
  );
}

function field<T extends Element>(container: HTMLElement, selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

describe('the New ticket form, when the agent switches form', () => {
  it('keeps who the ticket is for, and starts the form-specific part again', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    render(container, 'damaged-parcel', 'high');
    expect(field<HTMLSelectElement>(container, 'select[name="system.priority"]').value).toBe(
      'high',
    );

    field<HTMLInputElement>(container, 'input[name="requesterEmail"]').value = 'amira@example.com';
    field<HTMLInputElement>(container, 'input[name="requesterName"]').value = 'Amira';
    field<HTMLSelectElement>(container, 'select[name="categoryId"]').value = categories[1]!.id;

    render(container, 'general-enquiry', 'low');

    expect(field<HTMLInputElement>(container, 'input[name="slug"]').value).toBe('general-enquiry');
    // The caller's details stay typed.
    expect(field<HTMLInputElement>(container, 'input[name="requesterEmail"]').value).toBe(
      'amira@example.com',
    );
    expect(field<HTMLInputElement>(container, 'input[name="requesterName"]').value).toBe('Amira');
    // The category chosen for the first form is not posted with the second,
    // and the priority is the second form's default, not the first's.
    expect(field<HTMLSelectElement>(container, 'select[name="categoryId"]').value).toBe('');
    expect(field<HTMLSelectElement>(container, 'select[name="system.priority"]').value).toBe('low');
  });

  // The answer is the form component's, which a switch re-renders rather than
  // remounts, so a refusal of the first form's answers was still drawn under the
  // second form's questions — which may not ask what it names.
  it('shows a refusal under the form it refused, and not under the next one', async () => {
    vi.mocked(createTicketFromForm).mockResolvedValueOnce({ error: 'Fill in Order number' });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    render(container, 'damaged-parcel', 'high');
    field<HTMLInputElement>(container, 'input[name="requesterEmail"]').value = 'amira@example.com';
    await act(async () => {
      field<HTMLButtonElement>(container, 'button[type="submit"]').click();
    });
    expect(createTicketFromForm).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Fill in Order number');

    render(container, 'general-enquiry', 'low');
    expect(container.textContent).not.toContain('Fill in Order number');
  });
});
