'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Cell,
  ErrorText,
  Field,
  Input,
  Notice,
  Row,
  Select,
  Table,
  Textarea,
} from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { SubmitButton } from '@/components/submit-button';
import type { CategoryRow } from '@/lib/categories/queries';
import type { RouteGroupSummary } from '@/lib/categories/route-groups';
import { DangerAction, Disclosure, EditorForm, INITIAL } from '../forms-shared';
import { restoreCategory, retireCategory, saveCategory } from './actions';

/**
 * The category list, its editor, and the "New category" form.
 *
 * Everything here is drawn from plain rows the page read: the route-group
 * summaries included, so the picker can describe whichever group is chosen
 * without a round trip, and so this file names `lib/categories` by type only
 * and never pulls the schema into the browser.
 *
 * The Arabic label's input is `dir="rtl"` on the field rather than the page,
 * for the reason the subcategories page gives: the console stays left to
 * right, and it is the value being typed that is Arabic.
 */

type Category = CategoryRow & {
  /** Live tickets carrying it — what retiring it leaves behind. */
  tickets: number;
};

const STRATEGY_LABELS: Record<RouteGroupSummary['strategy'], string> = {
  manual: 'Manual',
  round_robin: 'Round robin',
  load_balanced: 'Load balanced',
};

export function NewCategory({
  routeGroups,
  nextPosition,
}: {
  routeGroups: RouteGroupSummary[];
  nextPosition: number;
}) {
  return (
    <Disclosure label="New category">
      {(close) => (
        <EditorForm action={saveCategory} submitLabel="Create category" onSaved={close}>
          <CategoryFields routeGroups={routeGroups} position={nextPosition} />
        </EditorForm>
      )}
    </Disclosure>
  );
}

/**
 * The list, and the editor for whichever row is open — above the table rather
 * than inside a cell, for the reason the groups page gives: a description and a
 * route group with its summary crushed into one column of a horizontally
 * scrolling table is unreadable on a phone. One editor at a time, so two open
 * forms cannot be saved into each other.
 */
export function CategoriesTable({
  rows,
  routeGroups,
}: {
  rows: Category[];
  routeGroups: RouteGroupSummary[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = rows.find((row) => row.id === editingId) ?? null;
  const editorRef = useRef<HTMLDivElement | null>(null);

  // The open form is above the table, so choosing the last row would
  // otherwise change something off-screen and look like nothing happened.
  useEffect(() => {
    if (editing) editorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [editing]);

  const groupById = new Map(routeGroups.map((group) => [group.id, group]));

  return (
    <>
      {editing ? (
        <div ref={editorRef} id="category-editor" className="mb-4">
          {/* Keyed so that opening another category remounts the form, route
              group choice included, rather than carrying the last one's over. */}
          <Card key={editing.id} className="w-full border-(--color-border-focus)/30!">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-sm font-semibold">{editing.labelEn}</h2>
              <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
            <EditorForm action={saveCategory} submitLabel="Save" onSaved={() => setEditingId(null)}>
              <CategoryFields
                category={editing}
                routeGroups={routeGroups}
                position={editing.position}
              />
            </EditorForm>
          </Card>
        </div>
      ) : null}

      <Table
        head={[
          'Category',
          <>
            Key{' '}
            <InfoTip label="Key">
              How the category is named where no person reads it: every change of a ticket&rsquo;s
              category records it, and Jev answers with one when it chooses. Fixed once the category
              exists — a renamed key would leave both naming something that no longer answers to it.
            </InfoTip>
          </>,
          'Arabic',
          'Position',
          <>
            Route group{' '}
            <InfoTip label="Route group">
              Where a ticket with this category goes on a channel that routes by category. No
              channel does yet, so nothing moves because of it today. Without one, the ticket stays
              in the group its channel puts it in.
            </InfoTip>
          </>,
          <>
            Tickets{' '}
            <InfoTip label="Tickets">
              Tickets carrying this category now, open or not, deleted ones left out. Retiring the
              category leaves every one of them as it is.
            </InfoTip>
          </>,
          '',
        ]}
      >
        {rows.map((category) => {
          const group = category.routeGroupId ? groupById.get(category.routeGroupId) : null;
          return (
            <Row key={category.id}>
              <Cell>
                <button
                  type="button"
                  onClick={() => setEditingId(category.id)}
                  aria-expanded={editingId === category.id}
                  aria-controls="category-editor"
                  className={`text-start font-medium hover:underline ${category.isActive ? '' : 'text-(--color-text-tertiary)'}`}
                >
                  {category.labelEn}
                </button>
                {/* Greyed name, ungreyed badge: the word is what says why. */}
                {category.isActive ? null : (
                  <span className="ms-2">
                    <Badge tone="neutral">Retired</Badge>
                  </span>
                )}
                {category.description ? (
                  <p className="mt-0.5 max-w-md text-xs text-(--color-text-secondary)">
                    {category.description}
                  </p>
                ) : null}
              </Cell>
              <Cell>
                <code className="text-xs text-(--color-text-secondary)">{category.key}</code>
              </Cell>
              <Cell>
                <span dir="rtl" lang="ar" className="text-sm">
                  {category.labelAr}
                </span>
              </Cell>
              <Cell className="text-(--color-text-secondary)">{category.position}</Cell>
              <Cell className="text-(--color-text-secondary)">
                {group ? (
                  <>
                    {group.name}
                    <span className="block text-xs">{STRATEGY_LABELS[group.strategy]}</span>
                    <span className="block text-xs">
                      {group.acceptingNow} of {group.members} accepting now
                    </span>
                    <RouteGroupWarning group={group} />
                  </>
                ) : (
                  <span className="text-xs">Channel&rsquo;s default</span>
                )}
              </Cell>
              <Cell className="text-(--color-text-secondary)">{category.tickets}</Cell>
              <Cell className="text-end">
                {category.isActive ? (
                  <DangerAction
                    action={retireCategory}
                    id={category.id}
                    label="Retire"
                    confirmLabel="Really retire?"
                  />
                ) : (
                  <RestoreAction id={category.id} />
                )}
              </Cell>
            </Row>
          );
        })}
      </Table>
    </>
  );
}

/**
 * The fields a new category and an edit share. The key is an input only on a
 * new one; an edit shows it and posts nothing under that name, because the
 * action would not read it anyway.
 */
function CategoryFields({
  category,
  routeGroups,
  position,
}: {
  category?: Category;
  routeGroups: RouteGroupSummary[];
  position: number;
}) {
  return (
    <>
      {category ? (
        <>
          <input type="hidden" name="id" value={category.id} />
          <p className="text-xs text-(--color-text-secondary)">
            Key <code>{category.key}</code> — fixed once a category exists.
          </p>
        </>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {category ? null : (
          <Field
            label="Key"
            hint="Lowercase words joined by underscores, such as merchant_support. It cannot be changed later."
          >
            <Input
              name="key"
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="merchant_support"
            />
          </Field>
        )}
        <Field label="Position" hint="Lower comes first, here and in every category picker.">
          <Input name="position" type="number" step={1} defaultValue={position} />
        </Field>
        <Field label="English label">
          <Input name="labelEn" required defaultValue={category?.labelEn} />
        </Field>
        <Field label="Arabic label">
          <Input name="labelAr" required dir="rtl" lang="ar" defaultValue={category?.labelAr} />
        </Field>
      </div>
      <Field
        label="Description"
        hint="What belongs here and where its edges are. Jev reads this beside the option when it chooses a category, so say what does not belong as well as what does."
      >
        <Textarea name="description" rows={3} defaultValue={category?.description ?? ''} />
      </Field>
      <RouteGroupField current={category?.routeGroupId ?? null} routeGroups={routeGroups} />
    </>
  );
}

/**
 * The route-group select, and what the chosen group will do with a ticket.
 *
 * Controlled, because the summary under it follows the choice; that is safe in
 * `EditorForm`, whose `useActionForm` takes no native reset on a refusal, so the
 * select cannot snap back to a group the summary no longer describes.
 */
function RouteGroupField({
  current,
  routeGroups,
}: {
  current: string | null;
  routeGroups: RouteGroupSummary[];
}) {
  const [groupId, setGroupId] = useState(current ?? '');
  const chosen = routeGroups.find((group) => group.id === groupId) ?? null;

  return (
    <div className="flex flex-col gap-2">
      <Field label="Route group">
        <Select
          name="routeGroupId"
          value={groupId}
          onChange={(event) => setGroupId(event.target.value)}
        >
          <option value="">No route group — stays in the channel&rsquo;s default group</option>
          {routeGroups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </Select>
      </Field>
      {chosen ? (
        <RouteGroupFacts group={chosen} />
      ) : (
        <p className="text-xs text-(--color-text-secondary)">
          A ticket with this category stays in whichever group its channel puts it in.
        </p>
      )}
    </div>
  );
}

/**
 * How the chosen group hands out work, as of when the page loaded.
 *
 * The warnings are for the two groups a routed ticket would sit in with
 * nobody assigned: a manual one, and one with no active members. Neither is
 * refused — a team that picks its own tickets from a queue is a real choice —
 * but routing a category there should be a decision, not a surprise.
 */
function RouteGroupFacts({ group }: { group: RouteGroupSummary }) {
  const members = group.members === 1 ? 'member' : 'members';

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--color-text-secondary)">
        <span>{STRATEGY_LABELS[group.strategy]}</span>
        <span className="inline-flex items-center gap-1">
          {group.acceptingNow} of {group.members} {members} accepting now
          <InfoTip label="Accepting now">
            Members signed in with the console open and their accepting switch on, as of when this
            page loaded — the same test assignment makes before it hands anybody a ticket. A
            ticket&rsquo;s skills or an agent&rsquo;s ticket cap can still pass somebody over.
          </InfoTip>
        </span>
        {group.strategy === 'manual' ? null : (
          <span>
            {group.assignWithinHoursOnly
              ? 'Assigns only within its business hours'
              : 'Assigns at any hour'}
          </span>
        )}
      </p>
      {group.strategy === 'manual' ? (
        <Notice tone="warning" icon>
          Manual: nobody is assigned automatically, so routed tickets wait unassigned in this group.
        </Notice>
      ) : group.members === 0 ? (
        <Notice tone="warning" icon>
          No active members: nobody can be assigned, so routed tickets wait unassigned in this
          group.
        </Notice>
      ) : null}
    </>
  );
}

/**
 * The editor's two warnings, short enough for the table's cell: the list is
 * where an admin scans every category's readiness at once, and a route group
 * that would leave tickets unassigned should not need an editor opened to see.
 */
function RouteGroupWarning({ group }: { group: RouteGroupSummary }) {
  if (group.strategy === 'manual') {
    return (
      <span className="mt-1 block">
        <Badge tone="warning">Nobody assigned automatically</Badge>
      </span>
    );
  }
  if (group.members === 0) {
    return (
      <span className="mt-1 block">
        <Badge tone="warning">No active members</Badge>
      </span>
    );
  }
  return null;
}

/**
 * Restoring is one click: it takes nothing away, and a category restored by
 * mistake is retired again the same way. Its own form of a hidden id and a
 * button, which a native reset has nothing to move in.
 */
function RestoreAction({ id }: { id: string }) {
  const [state, formAction] = useActionState(restoreCategory, INITIAL);

  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={id} />
      <SubmitButton idle="Restore" variant="secondary" />
      {state.error ? (
        <span className="max-w-xs text-end">
          <ErrorText inline>{state.error}</ErrorText>
        </span>
      ) : null}
    </form>
  );
}
