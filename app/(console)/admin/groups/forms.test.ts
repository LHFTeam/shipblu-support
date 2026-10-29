// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * What the group editor's members list posts when the page re-renders under
 * it — the agents page's case (`agents/forms.test.ts`) from the other side.
 * Another tab saving, or a group deleted, revalidates `/admin/groups` while an
 * editor is open; the boxes keep what they were drawn with, so the held set
 * they post must too, or an agent added from the agents page meanwhile is
 * posted as held and unticked, and taken off the group.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  unstable_rethrow: () => {},
}));
vi.mock('./actions', () => ({ saveGroup: vi.fn(), deleteGroup: vi.fn() }));

const { GroupsTable } = await import('./forms');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const OMAR = { value: '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44', label: 'Omar' };
const ZEINA = { value: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', label: 'Zeina' };

const SUPPORT = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  name: 'Support',
  description: null,
  businessHoursId: null,
  assignmentStrategy: 'manual' as const,
  matchSkills: false,
  skillTimeoutMins: null,
  defaultMaxOpenTickets: null,
  assignWithinHoursOnly: true,
  reclaimAfterMins: null,
  escalateToAgentId: null,
  escalateAfterMins: null,
};

describe('the group editor', () => {
  it('posts the members it was drawn with, after the page re-renders with others', () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const draw = (memberIds: string[]) =>
      act(() =>
        root!.render(
          createElement(GroupsTable, {
            rows: [
              {
                group: SUPPORT,
                scheduleName: null,
                members: memberIds.length,
                memberIds,
                tickets: 0,
              },
            ],
            schedules: [],
            agents: [OMAR, ZEINA],
            deactivatedAgents: [],
            defaultScheduleName: null,
          }),
        ),
      );

    draw([OMAR.value]);
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-controls="group-editor"]')!.click(),
    );
    // Zeina is added to Support from her own editor, and the page re-renders.
    draw([OMAR.value, ZEINA.value]);

    const data = new FormData(container.querySelector<HTMLFormElement>('#group-editor form')!);
    expect(data.getAll('memberIdsHeld')).toEqual([OMAR.value]);
    expect(data.getAll('memberIds')).toEqual([OMAR.value]);
  });
});
