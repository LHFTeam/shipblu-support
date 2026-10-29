// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * What the agent editor posts when the page re-renders under it.
 *
 * Any action on the page revalidates `/admin/agents` — a cap saved on another
 * row, an invite sent — and the editor's boxes are uncontrolled, so they keep
 * what they were drawn with plus the admin's clicks. A held set read from the
 * new props would then post a membership added elsewhere as held beside a box
 * drawn without it, and the save would read that as an untick. In a DOM
 * because that is where the disagreement lives: the hidden inputs and the
 * boxes are drawn by one render and read by the browser.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  unstable_rethrow: () => {},
}));
vi.mock('./actions', () => ({
  createInvite: vi.fn(),
  saveAgent: vi.fn(),
  savePresenceSettings: vi.fn(),
  setAgentActive: vi.fn(),
  setAgentCapacity: vi.fn(),
}));

const { AgentList } = await import('./forms');

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const SALES = { value: '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44', label: 'Sales' };
const CARE = { value: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', label: 'Customer Care' };
const AGENT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

function agent(values: { groupIds: string[]; role?: 'agent' | 'supervisor' }) {
  return {
    id: AGENT_ID,
    name: 'Bosy Essam',
    email: 'bosy@shipblu.test',
    role: values.role ?? 'agent',
    isActive: true,
    lastSeenAt: null,
    presence: 'offline' as const,
    isAcceptingTickets: true,
    maxOpenTickets: null,
    groupIds: values.groupIds,
    ownsNumber: false,
  };
}

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const draw = (values: Parameters<typeof agent>[0]) =>
    act(() =>
      root!.render(
        createElement(AgentList, {
          agents: [agent(values)],
          groups: [SALES, CARE],
          canEditGroups: true,
          selfId: 'somebody-else',
        }),
      ),
    );
  const open = () =>
    act(() =>
      container
        .querySelector<HTMLButtonElement>(`[aria-controls="agent-editor-${AGENT_ID}"]`)!
        .click(),
    );
  const posted = () =>
    new FormData(container.querySelector<HTMLFormElement>(`#agent-editor-${AGENT_ID} form`)!);
  return { draw, open, posted };
}

describe('the agent editor', () => {
  it('posts the groups it was drawn with, after the page re-renders with others', () => {
    const editor = mount();
    editor.draw({ groupIds: [SALES.value] });
    editor.open();

    // Somebody adds Bosy to Customer Care from the groups page, and a save
    // elsewhere on this page brings the new membership down.
    editor.draw({ groupIds: [SALES.value, CARE.value] });

    const data = editor.posted();
    expect(data.getAll('groupIdsHeld')).toEqual([SALES.value]);
    expect(data.getAll('groupIds')).toEqual([SALES.value]);
  });

  it('asks for no role change when the role moved under it and the select was left alone', () => {
    const editor = mount();
    editor.draw({ groupIds: [], role: 'agent' });
    editor.open();

    editor.draw({ groupIds: [], role: 'supervisor' });

    const data = editor.posted();
    expect(data.get('roleHeld')).toBe('agent');
    expect(data.get('role')).toBe(data.get('roleHeld'));
  });
});
