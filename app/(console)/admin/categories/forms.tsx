'use client';

import { useState } from 'react';
import { Badge, Cell, Row } from '@/components/ui';
import { saveCategory, saveRootCause, setCategoryActive, setRootCauseActive } from './actions';

/**
 * One editable row each, for a category and for a cause.
 *
 * Edit-in-place rather than a modal: there are eighty-odd rows between the two
 * tables and the only thing anybody changes is a label, so a dialogue per edit
 * is three clicks for a word.
 *
 * The Arabic input is `dir="rtl"` on the field rather than on the page. The
 * console is English and its layout should stay left-to-right; it is the value
 * being typed that is Arabic, and an Arabic label typed into a left-to-right
 * input puts its punctuation on the wrong end.
 */

type EditableLabels = { labelEn: string; labelAr: string };

function useLabelEditor(
  initial: EditableLabels,
  save: (state: { error: string | null }, formData: FormData) => Promise<{ error: string | null }>,
  id: string,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function commit() {
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.set('id', id);
    formData.set('labelEn', draft.labelEn);
    formData.set('labelAr', draft.labelAr);
    const result = await save({ error: null }, formData);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
  }

  function cancel() {
    setDraft(initial);
    setError(null);
    setEditing(false);
  }

  return { editing, setEditing, draft, setDraft, busy, error, commit, cancel };
}

export function CategoryRow({
  category,
  used,
}: {
  category: {
    id: string;
    key: string;
    area: string;
    labelEn: string;
    labelAr: string;
    audience: 'merchant' | 'recipient' | 'any';
    isActive: boolean;
    isDetectable: boolean;
  };
  used: number;
}) {
  const editor = useLabelEditor(
    { labelEn: category.labelEn, labelAr: category.labelAr },
    saveCategory,
    category.id,
  );
  const [togglingBusy, setTogglingBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // The action's answer is read, not dropped: a refusal is a sentence the row
  // has to show, and a throw must not leave the button busy until a reload.
  async function toggle() {
    setTogglingBusy(true);
    setToggleError(null);
    try {
      const formData = new FormData();
      formData.set('id', category.id);
      formData.set('active', category.isActive ? 'false' : 'true');
      const result = await setCategoryActive({ error: null }, formData);
      if (result.error) setToggleError(result.error);
    } catch {
      setToggleError('That did not save — reload the page and try again');
    } finally {
      setTogglingBusy(false);
    }
  }

  return (
    <Row>
      <Cell className={category.isActive ? '' : 'opacity-40'}>
        {editor.editing ? (
          <input
            className="app-input w-full text-sm"
            value={editor.draft.labelEn}
            aria-label={`English label for ${category.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelEn: event.target.value })}
          />
        ) : (
          <>
            <span className="font-medium">{category.labelEn}</span>
            {!category.isDetectable ? (
              <span className="ms-2">
                <Badge>by hand only</Badge>
              </span>
            ) : null}
            {!category.isActive ? (
              <span className="ms-2">
                <Badge tone="warning">retired</Badge>
              </span>
            ) : null}
          </>
        )}
        {editor.error ? <p className="mt-1 text-xs text-red-600">{editor.error}</p> : null}
        {toggleError ? <p className="mt-1 text-xs text-red-600">{toggleError}</p> : null}
      </Cell>

      <Cell>
        <code className="text-xs opacity-70">{category.key}</code>
      </Cell>

      <Cell>
        {editor.editing ? (
          <input
            className="app-input w-full text-sm"
            dir="rtl"
            lang="ar"
            value={editor.draft.labelAr}
            aria-label={`Arabic label for ${category.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelAr: event.target.value })}
          />
        ) : (
          <span dir="rtl" lang="ar" className="text-sm">
            {category.labelAr}
          </span>
        )}
      </Cell>

      <Cell className="text-xs opacity-70">{category.audience}</Cell>

      {/*
        Zero is not an error and is not styled as one — see the page. It only
        means something next to `by hand only`, which is why that badge exists.
      */}
      <Cell className="text-xs opacity-70">{used}</Cell>

      <Cell>
        <div className="flex items-center gap-1">
          {editor.editing ? (
            <>
              <button
                type="button"
                disabled={editor.busy}
                onClick={() => void editor.commit()}
                className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)]"
              >
                Save
              </button>
              <button
                type="button"
                onClick={editor.cancel}
                className="rounded px-2 py-1 text-xs opacity-60 hover:opacity-100"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => editor.setEditing(true)}
                className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)]"
              >
                Rename
              </button>
              <button
                type="button"
                disabled={togglingBusy}
                onClick={() => void toggle()}
                className="rounded px-2 py-1 text-xs opacity-60 hover:opacity-100"
              >
                {category.isActive ? 'Retire' : 'Restore'}
              </button>
            </>
          )}
        </div>
      </Cell>
    </Row>
  );
}

export function RootCauseRow({
  cause,
}: {
  cause: {
    id: string;
    key: string;
    labelEn: string;
    labelAr: string;
    owner: string;
    isActive: boolean;
  };
}) {
  const editor = useLabelEditor(
    { labelEn: cause.labelEn, labelAr: cause.labelAr },
    saveRootCause,
    cause.id,
  );
  const [togglingBusy, setTogglingBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  // The action's answer is read, not dropped: a refusal is a sentence the row
  // has to show, and a throw must not leave the button busy until a reload.
  async function toggle() {
    setTogglingBusy(true);
    setToggleError(null);
    try {
      const formData = new FormData();
      formData.set('id', cause.id);
      formData.set('active', cause.isActive ? 'false' : 'true');
      const result = await setRootCauseActive({ error: null }, formData);
      if (result.error) setToggleError(result.error);
    } catch {
      setToggleError('That did not save — reload the page and try again');
    } finally {
      setTogglingBusy(false);
    }
  }

  return (
    <Row>
      <Cell className={cause.isActive ? '' : 'opacity-40'}>
        {editor.editing ? (
          <input
            className="app-input w-full text-sm"
            value={editor.draft.labelEn}
            aria-label={`English label for ${cause.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelEn: event.target.value })}
          />
        ) : (
          <>
            <span className="font-medium">{cause.labelEn}</span>
            {!cause.isActive ? (
              <span className="ms-2">
                <Badge tone="warning">retired</Badge>
              </span>
            ) : null}
          </>
        )}
        {editor.error ? <p className="mt-1 text-xs text-red-600">{editor.error}</p> : null}
        {toggleError ? <p className="mt-1 text-xs text-red-600">{toggleError}</p> : null}
      </Cell>

      <Cell>
        <code className="text-xs opacity-70">{cause.key}</code>
      </Cell>

      <Cell>
        {editor.editing ? (
          <input
            className="app-input w-full text-sm"
            dir="rtl"
            lang="ar"
            value={editor.draft.labelAr}
            aria-label={`Arabic label for ${cause.key}`}
            onChange={(event) => editor.setDraft({ ...editor.draft, labelAr: event.target.value })}
          />
        ) : (
          <span dir="rtl" lang="ar" className="text-sm">
            {cause.labelAr}
          </span>
        )}
      </Cell>

      {/*
        Shown, never editable. The key's prefix names the owner and a CHECK holds
        the two together, so an edit here would be rejected by the database
        rather than accepted and wrong — which is the right outcome, but a
        control that always fails is worse than no control.
      */}
      <Cell>
        <Badge>{cause.owner}</Badge>
      </Cell>

      <Cell>
        <div className="flex items-center gap-1">
          {editor.editing ? (
            <>
              <button
                type="button"
                disabled={editor.busy}
                onClick={() => void editor.commit()}
                className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)]"
              >
                Save
              </button>
              <button
                type="button"
                onClick={editor.cancel}
                className="rounded px-2 py-1 text-xs opacity-60 hover:opacity-100"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => editor.setEditing(true)}
                className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)]"
              >
                Rename
              </button>
              <button
                type="button"
                disabled={togglingBusy}
                onClick={() => void toggle()}
                className="rounded px-2 py-1 text-xs opacity-60 hover:opacity-100"
              >
                {cause.isActive ? 'Retire' : 'Restore'}
              </button>
            </>
          )}
        </div>
      </Cell>
    </Row>
  );
}
